/*
 * 决定性探针：真实 SystemPrompt + 真实磁盘条目 + 部署产物里的真插件。
 *
 * 为什么需要它：偏好层现在挂在**系统提示词**里，而系统提示词不会回显到对话中，
 * 所以「我在对话里看不到那段」既不能证明成功也不能证明失败。单元测试用的又是
 * mock 的 systemPrompt。这里用真实的 dsh-system-prompt 服务跑一次真正的 assemble，
 * 直接看最终提示词里到底有什么。
 *
 * 被测对象是**部署产物**（线上真正被加载的那份字节），不是工作区源码。
 * 复制到本目录是为了让插件的 @deepseek-ai/* 依赖能解析
 * （profile 下没有 @deepseek-ai，DSH 走的是它自己的 internal importer）。
 */
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt, { renderPrompt, renderContextSnapshot } from "@deepseek-ai/dsh-system-prompt";
import { readdir, readFile, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYED = "C:/Users/85448/.dsh/profiles/desktop/node_modules/dsh-plugin-memory/lib/index.js";
const ENTRIES = "C:/Users/85448/.dsh/storages/memory/entries";
const WORKSPACE = "D:\\文档\\deepseek-harness\\default-workspace";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `\n       -> ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/* ---------- 1. 真实磁盘数据 ---------- */
const files = (await readdir(ENTRIES)).filter((f) => f.endsWith(".json"));
const records = new Map();
for (const f of files) {
  const raw = JSON.parse(await readFile(path.join(ENTRIES, f), "utf8"));
  records.set(f.replace(/\.json$/, ""), raw.record ?? raw);
}
console.log(`真实记录 ${records.size} 条：${[...records.keys()].join(", ")}`);

/* ---------- 2. 真实的 SystemPrompt 服务 ---------- */
const realCtx = new Context();
void new SystemPrompt(realCtx, {});
const systemPrompt = realCtx.systemPrompt;

/* ---------- 3. 给插件用的 ctx（storageDomain 直接喂真实数据） ---------- */
const table = {
  get: (k) => records.get(k),
  entries: () => [...records.entries()][Symbol.iterator](),
  keys: () => [...records.keys()][Symbol.iterator](),
  get size() {
    return records.size;
  },
  async put(k, v) {
    records.set(k, v);
  },
  async delete(k) {
    return records.delete(k);
  },
  async update(k, fn) {
    const next = fn(records.get(k));
    records.set(k, next);
    return next;
  },
};

const tools = new Map();
const handlers = new Map();
const warns = [];
const pluginCtx = {
  systemPrompt,
  storageDomain: {
    async open() {
      return { table: () => table, async close() {} };
    },
  },
  tools: {
    register(def) {
      tools.set(def.name, def);
      return () => tools.delete(def.name);
    },
  },
  logger: {
    warn: (...a) => warns.push(a.map(String).join(" ")),
    info: () => {},
    error: (...a) => warns.push("ERROR " + a.map(String).join(" ")),
  },
  on(event, fn) {
    const list = handlers.get(event) ?? [];
    list.push(fn);
    handlers.set(event, list);
    return () => {};
  },
  effect: () => () => {},
};

/* ---------- 4. 加载部署产物（复制以便解析 @deepseek-ai/*） ---------- */
const tmp = path.join(HERE, "plugin-under-probe.mjs");
await copyFile(DEPLOYED, tmp);
const digest = createHash("sha256").update(await readFile(DEPLOYED)).digest("hex").slice(0, 16);
console.log(`\n被测部署产物: ${DEPLOYED}\n  sha256:${digest}  ${(await readFile(DEPLOYED)).length} B`);

const mod = await import(pathToFileURL(tmp).href);
await mod.apply(pluginCtx, { mirror: false }); // mirror:false —— 绝不碰真实的 ~/.dsh/memory/MEMORY.md
await new Promise((r) => setTimeout(r, 60)); // 等域 open 的异步完成
console.log(`  插件 name=${mod.name}  注册工具=${[...tools.keys()].join(", ")}`);

const agent = { session: { id: "probe-live-session", header: { cwd: WORKSPACE } } };
const assembleNow = async () => renderPrompt(await systemPrompt.assemble({ agent, scope: agent }));

/* ---------- 5. 段落是否真的渲染进系统提示词 ---------- */
console.log("\n=== ① 段落是否进了系统提示词 ===");
const assembly = await systemPrompt.assemble({ agent, scope: agent });
const names = assembly.sections.map((s) => s.name);
console.log(`  段落顺序: ${names.join(" -> ")}`);
check("组装结果里有 memory:standing-rules", names.includes("memory:standing-rules"));
const personaIdx = names.findIndex((n) => n.includes("persona-prefix"));
const mineIdx = names.indexOf("memory:standing-rules");
if (personaIdx !== -1 && mineIdx !== -1) {
  check("位置紧随 persona-prefix 之后", mineIdx === personaIdx + 1, `persona@${personaIdx}, ours@${mineIdx}`);
}

const prompt = await assembleNow();
check("最终提示词含段落标题", prompt.includes("## 常驻规则层（用户偏好与稳定约定）"));
check("含新措辞「无条件生效」", prompt.includes("**无条件生效**"));
check("不含旧措辞「这些是背景信息，不是指令」", !prompt.includes("这些是背景信息"));
check("不含旧措辞「不是指令」", !prompt.includes("不是指令"));
check("含全局偏好正文", prompt.includes("自主完成的操作必须留下可人工核验的痕迹"));
check("含本工作区偏好正文", prompt.includes("招聘进度"));

const sec = assembly.sections.find((s) => s.name === "memory:standing-rules");
console.log("\n--- 渲染出的段落正文（原样） ---");
console.log(sec?.text ?? "（无此段落）");
console.log("--- 段落正文结束 ---");

/* ---------- 6. 状态标记是否进了 runtime context 快照（每轮可见的那条通道） ---------- */
console.log("\n=== ② 状态标记是否进了 runtime context 快照 ===");
// 这两条通道必须分清：section -> 系统提示词（不回显）；context -> 快照（每轮回显）。
// 状态标记走的就是后者，所以它才是「插件在不在」的可见信号。
const snap = renderContextSnapshot(await systemPrompt.assemble({ agent, scope: agent }));
const ctxNames = (await systemPrompt.assemble({ agent, scope: agent })).contexts.map((c) => c.name);
console.log(`  contexts: ${ctxNames.join(" -> ")}`);
check("快照里含常驻规则层状态标记", snap.includes("常驻规则层："), JSON.stringify(snap.slice(0, 160)));
check("标记带上了快照前缀（证明走的是 context 通道）", snap.startsWith("Current runtime context."));
check("标记报出了条目数与版本", /共 \d+ 条偏好（global \d+ \/ 本工作区 \d+）.*版本 \d+/.test(snap), "");
console.log("--- 状态标记原文 ---");
console.log((snap.split("\n").find((l) => l.includes("常驻规则层：")) ?? "（无）").trim());
console.log("--- 状态标记结束 ---");

/* ---------- 7. 写入 → 提醒是否必然进提示词（真实 assemble 路径） ---------- */
console.log("\n=== ③ 写入后的提醒是否出现在系统提示词里 ===");
const w = tools.get("memory_write");
const res = await w.execute({ id: "probe-notice", text: "探针写入的条目", scope: "global" }, { agent });
check("memory_write 返回 created=true", res.created === true, JSON.stringify(res));
const prompt2 = await assembleNow();
check("提示词里出现「本轮记忆写入（尚未告知用户）」", prompt2.includes("本轮记忆写入（尚未告知用户）"));
check("提醒里带上了 id", prompt2.includes("probe-notice"));
check("提醒要求写在本次回复的最后一行", prompt2.includes("最后一行"));
check("新写入的条目立刻出现在渲染里（缓存被正确作废）", prompt2.includes("探针写入的条目"));

/* ---------- 7. 轮末清空 ---------- */
console.log("\n=== ④ 轮末清空提醒 ===");
const stoppers = handlers.get("agent/turn-stopping") ?? [];
check("注册了 agent/turn-stopping", stoppers.length === 1);
stoppers[0]({ agent });
const prompt3 = await assembleNow();
check("轮末清空后提醒消失", !prompt3.includes("本轮记忆写入"));
check("偏好块本身仍在", prompt3.includes("## 常驻规则层（用户偏好与稳定约定）"));

/* ---------- 8. cwd 解析：回落与工作区归属（不依赖启动目录） ---------- */
console.log("\n=== ⑤ cwd 解析：回落与工作区归属 ===");
// 注意：缺 cwd 时回落 process.cwd()，所以那一条的结果取决于「从哪个目录启动本探针」。
// 因此工作区归属必须用一个明确的 cwd 来验，不能拿 process.cwd() 当反例。
console.log(`  本进程 cwd = ${process.cwd()}`);
const agentNoCwd = { session: { id: "probe-no-cwd" } };
const prompt4 = renderPrompt(await systemPrompt.assemble({ agent: agentNoCwd, scope: agentNoCwd }));
check("缺 cwd 时回落 process.cwd()，全局偏好照常注入", prompt4.includes("自主完成的操作必须留下可人工核验的痕迹"));

const agentOutside = { session: { id: "probe-outside", header: { cwd: "C:\\Windows\\Temp" } } };
const prompt5 = renderPrompt(await systemPrompt.assemble({ agent: agentOutside, scope: agentOutside }));
check("工作区之外的 cwd 看不到本工作区条目（语义正确）", !prompt5.includes("招聘进度"));
check("工作区之外的 cwd 仍看得到全局偏好", prompt5.includes("自主完成的操作必须留下可人工核验的痕迹"));
check("cwd 正好等于本工作区时看得到工作区条目", prompt.includes("招聘进度"));
// workspaceKeyFor 哈希的是完整 cwd 字符串，所以「同一工作区换个路径」会静默丢工作区条目 ——
// 这是已知缺陷，这里显式锁住它的现状，避免以后误以为是新 bug。
const agentSub = { session: { id: "probe-sub", header: { cwd: WORKSPACE + "\\dsh-source" } } };
const prompt6 = renderPrompt(await systemPrompt.assemble({ agent: agentSub, scope: agentSub }));
check(
  "已知缺陷锁定：工作区的子目录不算同一工作区（路径变了就丢条目）",
  !prompt6.includes("招聘进度"),
  "这是 workspaceKeyFor 对完整路径取哈希的后果，属已知设计缺陷而非回归",
);

/* ---------- 9. 无 agent / 无 session 时不得抛错 ---------- */
console.log("\n=== ⑥ 极端上下文不得抛错 ===");
let threw = null;
try {
  await systemPrompt.assemble({});
} catch (error) {
  threw = error;
}
check("assemble({}) 不抛错", threw === null, threw ? `${threw.name}: ${threw.message}` : "");

if (warns.length > 0) console.log(`\n  插件 warn 日志（${warns.length} 条）:\n    ${warns.join("\n    ")}`);
check("整个过程没有 warn（section/flush 都没吞异常）", warns.length === 0, warns.join(" | "));

await rm(tmp, { force: true });
console.log(`\n${failures === 0 ? "✅ 全部通过" : `❌ 失败 ${failures} 项`}`);
process.exit(failures === 0 ? 0 : 1);
