/**
 * 用真实插件代码 + 真实工作区里刚生成的文件，模拟一次 agent/pre-step，
 * 看注入内容是否正确。这能在重启前证明种子文件的格式与插件期望一致。
 *
 * 注意：载入会话时会顺手生成 .dsh/WORKING.md。为保留"重启后由插件生成"
 * 这一证据，本脚本结束时会把刚生成的 WORKING.md 删掉（仅删它自己刚建的那个）。
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = "D:\\文档\\deepseek-harness\\default-workspace\\working-memory-test";
register(pathToFileURL(path.join(HERE, "mocks", "hooks.mjs")), import.meta.url);

const mod = await import(
  pathToFileURL("D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-working-memory\\lib\\index.js").href
);

const WS = "D:\\文档\\deepseek-harness\\default-workspace";
const SESSION_ID = "session-b50d5537-da93-4704-b2d0-0429dad12493";
const ENTRY = path.join(WS, ".dsh", "WORKING.md");
const entryExistedBefore = fs.existsSync(ENTRY);

/* 与真实 ctx 接口一致的最小实现 */
const tools = new Map();
const handlers = new Map();
const ctx = {
  logger: { warn: (...a) => console.log("  [warn]", ...a), info: () => {}, error: () => {} },
  sessionProjections: { register() {}, stateOf: () => ({ injectedAt: null, demandId: null, fingerprint: "", compactionSeq: null }) },
  tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name); } },
  on(e, fn) { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(fn); return () => {}; },
};

mod.apply(ctx, {});

const session = { id: SESSION_ID, title: "你好", header: { cwd: WS } };

async function preStep(claimed) {
  const list = handlers.get("agent/pre-step") ?? [];
  const contextBlock = { role: "user", source: { kind: "runtime-context" }, content: "【运行时上下文】" };
  let i = 0;
  const next = async () => {
    if (i >= list.length) return { kind: "enter", messages: [...claimed, contextBlock] };
    return list[i++]({ agent: { session }, messages: claimed, turn: 1, step: 1, signal: { aborted: false } }, next);
  };
  return next();
}

console.log("=== 模拟第 1 步（会话首步，相当于重启后第一个回合）===");
const d = await preStep([{ role: "user", content: "继续" }]);
const wm = d.messages.filter((m) => m.source?.kind === "working-memory");
console.log("注入消息条数:", wm.length);
console.log("消息顺序:", d.messages.map((m) => m.source?.kind ?? "普通").join(" | "));

if (wm.length === 0) {
  console.log("\n❌ 没有注入！种子文件格式可能不对。");
  process.exit(1);
}

const body = wm[0].content.map((c) => c.text).join("\n");
console.log("\n=== 注入正文 ===");
console.log(body.split("\n").map((l) => "  " + l).join("\n"));

console.log("\n=== 关键内容断言 ===");
const must = [
  ["当前需求名", "构建跨会话记忆系统"],
  ["需求目标", "在 DSH 里建立分层跨会话记忆"],
  ["需求状态", "需求状态：进行中"],
  ["下一步", "重启 DSH，验证插件能从这两个文件恢复并注入"],
  ["卡点", "bundle 层不生效"],
  ["其他需求（可切回）", "feishu-doc-plugin"],
  ["其他需求状态", "已完成"],
  ["不是当前指令声明", "不是当前指令"],
  ["不构成证据声明", "不构成证据"],
];
let bad = 0;
for (const [label, needle] of must) {
  const ok = body.includes(needle);
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok) bad += 1;
}

console.log("\n=== 模拟第 2 步（状态未变，应不重复注入）===");
const d2 = await preStep([{ role: "user", content: "再问" }]);
const n2 = d2.messages.filter((m) => m.source?.kind === "working-memory").length;
console.log(`  ${n2 === 1 ? "✅" : "❌"} 仍只有 1 份（实际 ${n2}）`);
if (n2 !== 1) bad += 1;

console.log("\n=== 模拟压缩后（应能补回）===");
// 模拟"上下文被压缩、记忆块被摘掉"：本步只带一条摘要消息，且决策里不含记忆块
const d3 = await preStep([{ role: "user", content: "【摘要】此前对话已压缩" }]);
const n3 = d3.messages.filter((m) => m.source?.kind === "working-memory").length;
console.log(`  ${n3 === 1 ? "✅" : "❌"} 压缩后仍有 1 份（实际 ${n3}）`);
if (n3 !== 1) bad += 1;

/* ---------------------------------------------------------------- 收尾 */
if (!entryExistedBefore && fs.existsSync(ENTRY)) {
  fs.rmSync(ENTRY);
  console.log("\n已删除本次验证顺手生成的 .dsh/WORKING.md，留给重启后由插件生成。");
}

console.log(`\n${bad === 0 ? "✅ 验证通过" : `❌ ${bad} 项不符`}`);
process.exit(bad === 0 ? 0 : 1);
