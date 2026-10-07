/**
 * 只加载插件的真实模块，用"一被调用就报错"的桩，确认：
 *   1) 模块顶层求值（Config、defineDomain）是否抛错
 *   2) apply 里 apply() 之前有多少同步代码
 *
 * 这能区分「模块加载失败」与「apply 没被调用」——
 * 两者在 UI 上都表现为"插件已启用"，但原因完全不同。
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const MOCKS = "D:\\文档\\deepseek-harness\\default-workspace\\memory-plugin-test\\mocks";
const REAL = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\node_modules\\@deepseek-ai";

/**
 * 关键：这里用「真实」的 storage-domain 与 schemastery，
 * 只把 dsh-llm / session-projection / tools 换成桩（它们只在 apply 内部被用到）。
 */
const hooks = path.join(MOCKS, "hooks-real.mjs");
fs.writeFileSync(
  hooks,
  `import { pathToFileURL } from "node:url";
import path from "node:path";
const REAL = ${JSON.stringify(REAL)};
const MOCKS = ${JSON.stringify(MOCKS)};
const MAP = new Map([
  ["@deepseek-ai/schemastery", path.join(REAL, "schemastery", "lib", "index.mjs")],
  ["@deepseek-ai/dsh-storage-domain", path.join(REAL, "dsh-storage-domain", "lib", "index.js")],
  ["@deepseek-ai/dsh-llm", path.join(MOCKS, "dsh-llm.mjs")],
  ["@deepseek-ai/dsh-session-projection", path.join(MOCKS, "dsh-session-projection.mjs")],
  ["@deepseek-ai/dsh-tools", path.join(MOCKS, "dsh-tools.mjs")],
]);
export async function resolve(spec, ctx, next) {
  const f = MAP.get(spec);
  if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
  return next(spec, ctx);
}
`,
  "utf8",
);
register(pathToFileURL(hooks), import.meta.url);

const PLUGIN = pathToFileURL(
  "D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-memory\\lib\\index.js",
).href;

console.log("=== 1. 尝试加载插件模块（顶层求值 Config 与 defineDomain）===");
let mod;
try {
  mod = await import(PLUGIN);
  console.log("  ✅ 模块加载成功，未在顶层抛错");
  console.log("  导出:", Object.keys(mod).join(", "));
  console.log("  name =", mod.name);
  console.log("  inject =", JSON.stringify(mod.inject));
  console.log("  Config 类型 =", typeof mod.Config);
  console.log("  apply 类型 =", typeof mod.apply);
} catch (error) {
  console.log("  ❌ 模块加载失败 —— 这就是插件不生效的原因！");
  console.log("  错误:", error.name, "|", error.message);
  console.log("  栈:");
  console.log(String(error.stack).split("\n").slice(0, 12).map((l) => "    " + l).join("\n"));
  process.exit(1);
}

console.log("\n=== 2. 用真实 schemastery 校验 Config ===");
try {
  const out = mod.Config({ maxInject: 24, maxEntryChars: 500, mirror: true });
  console.log("  ✅ Config 校验通过:", JSON.stringify(out));
} catch (e) {
  console.log("  ❌ Config 校验失败:", e.message);
}

console.log("\n=== 3. 调用 apply()（用最小 ctx，看是否同步抛错）===");
const calls = [];
let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (detail !== undefined) console.log(`       ${detail}`);
  ok ? pass++ : fail++;
};
const ctx = {
  logger: { warn: (...a) => calls.push(["warn", ...a]), info: () => {}, error: (...a) => calls.push(["error", ...a]) },
  storageDomain: {
    async open(spec) {
      calls.push(["open", spec.name, spec.version, spec.layout]);
      throw new Error("（桩：故意让 open 失败，以验证错误是否被如实报告）");
    },
  },
  // 改造后 inject 里已无 sessionProjections，这里刻意不提供，任何残留依赖都会立刻抛错
  systemPrompt: {
    getSectionOrder(name) {
      calls.push(["getSectionOrder", name]);
      return 0;
    },
    getContextOrder(name) {
      calls.push(["getContextOrder", name]);
      return 120;
    },
    section(def) {
      calls.push(["section", def.name]);
      return () => {};
    },
    context(def) {
      calls.push(["context", def.name]);
      return () => {};
    },
  },
  tools: { register: (d) => { calls.push(["tool", d.name]); return () => {}; } },
  on: (e) => calls.push(["on", e]),
  effect: () => calls.push(["effect"]),
};
let syncError;
let dispose;
try {
  dispose = mod.apply(ctx, { maxInject: 24, maxEntryChars: 500, mirror: true });
  console.log("  ✅ apply() 同步部分执行成功，返回 disposer:", typeof dispose);
} catch (e) {
  syncError = e;
  console.log("  ❌ apply() 同步抛错:", e.name, "|", e.message);
  console.log(String(e.stack).split("\n").slice(0, 10).map((l) => "    " + l).join("\n"));
}

await new Promise((r) => setTimeout(r, 60));
console.log("\n  apply 期间的调用序列:");
for (const c of calls) console.log("   ", JSON.stringify(c));

console.log("\n=== 3b. apply() 注册契约（改造后）===");
const has = (pred) => calls.some(pred);
check("apply() 不再同步抛错（ctx.systemPrompt 桩已具备）", syncError === undefined, syncError?.message);
check("返回 disposer", typeof dispose === "function");
check(
  "注册了 systemPrompt 段落 memory:standing-rules",
  has((c) => c[0] === "section" && c[1] === "memory:standing-rules"),
);
check("先问过 DEPLOYMENT_PERSONA_PREFIX 的顺序", has((c) => c[0] === "getSectionOrder" && c[1] === "DEPLOYMENT_PERSONA_PREFIX"));
check(
  "注册了 runtime context memory:standing-rules-status（状态标记，走 context 才每轮可见）",
  has((c) => c[0] === "context" && c[1] === "memory:standing-rules-status"),
);
check("先问过 SUBAGENT_DELEGATION 的 context 顺序", has((c) => c[0] === "getContextOrder" && c[1] === "SUBAGENT_DELEGATION"));
check("**没有**把状态标记也注册成 section（两处都挂会导致重复渲染）", !has((c) => c[0] === "section" && c[1] === "memory:standing-rules-status"));
check("注册了 agent/turn-stopping", has((c) => c[0] === "on" && c[1] === "agent/turn-stopping"));
check("注册了 session/flush", has((c) => c[0] === "on" && c[1] === "session/flush"));
check("**没有**注册 agent/pre-step", !has((c) => c[0] === "on" && c[1] === "agent/pre-step"));
check("注册了 3 个工具", calls.filter((c) => c[0] === "tool").length === 3, calls.filter((c) => c[0] === "tool").map((c) => c[1]));
// open 抛错 → table 永远没就绪，因此 effect 不应被调用
check("开域失败时不注册 effect（没有可关闭的域）", !has((c) => c[0] === "effect"));

console.log("\n=== 4. 读取探针日志 ===");
const probeFile = "D:\\文档\\deepseek-harness\\default-workspace\\memory-probe.log";
if (fs.existsSync(probeFile)) {
  console.log(fs.readFileSync(probeFile, "utf8").split("\n").map((l) => "  " + l).join("\n"));
} else {
  console.log("  （探针日志不存在）");
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"} —— 通过 ${pass}，失败 ${fail}`);
console.log("（注：'storageDomain.open 抛错' 是本脚本的故意桩，不计为失败。）");
process.exit(fail === 0 ? 0 : 1);
