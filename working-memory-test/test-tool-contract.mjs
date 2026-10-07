/**
 * 工具定义契约测试 —— 用 dsh-tools 的**真实校验器**验证插件注册的工具。
 *
 * 存在的理由：此前 mock 的 ctx.tools.register 不校验任何东西，导致插件把
 * `returns` 写成该有的 `output` 也能 75 项全绿，而真机上 apply() 一上来就抛
 * TypeError（dsh-tools/lib/index.js:2881 要求 output { schema, render }），
 * 整个插件挂不上。这个测试就是那种失败模式的守门人。
 *
 * 覆盖三层：
 *  1. register() 的契约（output.schema / output.render 等）
 *  2. output.schema 属于 dsh-tools 支持的 JSON Schema 子集
 *  3. 每个工具真实执行后的返回值，确实满足它自己声明的 output.schema
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HERE = "D:\\文档\\deepseek-harness\\default-workspace\\working-memory-test";
register(pathToFileURL(path.join(HERE, "mocks", "hooks-dsh-real.mjs")), import.meta.url);

const TOOLS_URL =
  "file:///D:/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/dsh-source/node_modules/@deepseek-ai/dsh-tools/lib/index.js";
const PLUGIN_URL =
  "file:///D:/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/dsh-plugin-working-memory/lib/index.js";

const realTools = await import(TOOLS_URL);
const mod = await import(PLUGIN_URL);

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok && detail !== undefined) console.log(`       ${detail}`);
  ok ? (pass += 1) : (fail += 1);
};

/** 逐字复刻 dsh-tools/lib/index.js:2878-2886 的 register() 契约 */
function assertToolDefinition(definition) {
  const name = definition.name;
  const output = definition.output;
  if (
    output === undefined ||
    typeof output !== "object" ||
    typeof output.render !== "function" ||
    (output.presentationMeta !== undefined && typeof output.presentationMeta !== "function")
  ) {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  }
  realTools.assertSupportedJsonSchema(output.schema);
  const timeoutMs = definition.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
  }
  if (name === "run_code") throw new Error(`tool name "run_code" is reserved`);
}

console.log("=== 1. 用真实校验器注册工具（模拟 apply()）===");
const tools = new Map();
const handlers = new Map();
const registerErrors = [];
const ctx = {
  logger: { warn: (...a) => console.log("      [warn]", ...a), info: () => {}, error: () => {} },
  sessionProjections: { register() {}, stateOf: () => null },
  tools: {
    register(definition) {
      try {
        assertToolDefinition(definition);
      } catch (e) {
        registerErrors.push(`${definition?.name}: ${e.message}`);
        throw e;
      }
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
  on(e, fn) {
    if (!handlers.has(e)) handlers.set(e, []);
    handlers.get(e).push(fn);
    return () => {};
  },
};

let applyThrew = null;
try {
  mod.apply(ctx, {});
} catch (e) {
  applyThrew = e;
}

check("apply() 未抛错", applyThrew === null, applyThrew ? `${applyThrew.constructor.name}: ${applyThrew.message}` : "");
check("4 个工具全部注册成功", tools.size === 4, `实际 ${tools.size}：${[...tools.keys()].join(", ")}`);
check("注册过程无契约错误", registerErrors.length === 0, registerErrors.join("; "));

console.log("\n=== 2. 每个工具的 output 契约 ===");
for (const [name, def] of tools) {
  check(
    `${name}: 声明了 output { schema, render }`,
    def.output !== undefined && typeof def.output.schema === "object" && typeof def.output.render === "function",
    JSON.stringify({ hasOutput: def.output !== undefined, hasRender: typeof def.output?.render }),
  );
  check(`${name}: 未误用 returns 字段`, def.returns === undefined);
}

console.log("\n=== 3. 真实执行 → 返回值必须满足自己声明的 schema ===");
const WS = await fsp.mkdtemp(path.join(os.tmpdir(), "wm-contract-"));
const session = { id: "sess-contract", title: "契约测试", header: { cwd: WS } };
const callCtx = { agent: { session } };

const calls = [
  ["working_memory_start", { id: "t1", name: "需求一", query: "原始 query", goal: "目标一" }],
  ["working_memory_save", { status: "进行中", next: ["a", "b"], decisions: ["d"], done: [], blockers: [], files: ["f"] }],
  ["working_memory_list", {}],
  ["working_memory_recall", {}],
  ["working_memory_recall", { id: "t1" }],
  ["working_memory_recall", { id: "no-such" }],
];

for (const [toolName, args] of calls) {
  const def = tools.get(toolName);
  const label = `${toolName}(${JSON.stringify(args).slice(0, 40)})`;
  let value;
  let threw = null;
  try {
    value = await def.execute(args, callCtx);
  } catch (e) {
    threw = e;
  }
  if (threw !== null) {
    check(`${label} 执行成功`, false, `${threw.constructor.name}: ${threw.message}`);
    continue;
  }
  const violations = realTools.validateJsonSchemaValue(def.output.schema, value, "");
  check(`${label} 返回值满足 output.schema`, violations.length === 0, violations.join("; "));

  // render 必须能在真实值上工作
  let rendered;
  let renderThrew = null;
  try {
    rendered = def.output.render(args, value);
  } catch (e) {
    renderThrew = e;
  }
  check(
    `${label} render() 可用`,
    renderThrew === null && Array.isArray(rendered) && rendered.length > 0,
    renderThrew ? String(renderThrew) : `返回 ${Array.isArray(rendered) ? rendered.length : typeof rendered} 项`,
  );
}

console.log("\n=== 4. 参数 schema 也在受支持子集内 ===");
for (const [name, def] of tools) {
  let ok = true;
  let detail = "";
  try {
    realTools.assertObjectJsonSchema(def.parameters);
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  check(`${name}: parameters 合法`, ok, detail);
}

await fsp.rm(WS, { recursive: true, force: true });

console.log("\n=== 5. 自证：这个测试确实能抓到 `returns` 误用 ===");
// 如果守门人本身无效，前面全绿也没有意义。
let caught = null;
try {
  assertToolDefinition({
    name: "fake",
    parameters: { type: "object", properties: {} },
    returns: { type: "object", properties: {} }, // ← 正是这次真机上的错误写法
  });
} catch (e) {
  caught = e;
}
check(
  "用 returns 的定义会被拒绝",
  caught !== null && /must declare output/.test(caught.message),
  caught === null ? "❌ 未被拒绝 —— 守门人失效！" : caught.message,
);

let caught2 = null;
try {
  // output 存在但缺 render，也应被拒绝
  assertToolDefinition({ name: "fake2", output: { schema: { type: "object", properties: {} } } });
} catch (e) {
  caught2 = e;
}
check("缺 output.render 会被拒绝", caught2 !== null && /must declare output/.test(caught2.message), caught2?.message);

let caught3 = null;
try {
  // schema 含不受支持的关键字，应被真实校验器拒绝
  assertToolDefinition({
    name: "fake3",
    output: { schema: { type: "object", properties: {}, patternProperties: {} }, render: () => [] },
  });
} catch (e) {
  caught3 = e;
}
check("非法 schema 关键字会被拒绝", caught3 !== null, caught3?.message);

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"} —— 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
