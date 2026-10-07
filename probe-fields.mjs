/**
 * 深入看会话事件的字段细节：token 统计、compaction、消息重建所需的全部信息。
 */
import fs from "node:fs";

const lines = fs
  .readFileSync("D:\\文档\\deepseek-harness\\default-workspace\\session-dump.jsonl", "utf8")
  .split("\n")
  .filter((l) => l.trim());
const ev = lines.map((l) => JSON.parse(l));

const byType = (t) => ev.filter((e) => e.type === t);

console.log("=== ① assistant/message 的 data 字段全貌 ===");
const a = byType("assistant/message")[0];
console.log("  keys:", Object.keys(a.data).join(", "));
console.log("  message.role:", a.data.message?.role);
console.log("  content 块类型:", (a.data.message?.content ?? []).map((c) => c.type).join(", "));
console.log("  有 usage 吗:", a.data.usage ? JSON.stringify(a.data.usage) : "❌ 无");
console.log("  surfaceOp:", a.surfaceOp);
console.log("  其他 data 键:", Object.keys(a.data).filter((k) => k !== "message" && k !== "turn" && k !== "step").join(", ") || "(无)");

console.log("\n=== ② 有没有 token / usage 统计事件 ===");
const usageKeys = new Set();
for (const e of ev) {
  const scan = (o, prefix = "") => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (/usage|token|cost|input|output/i.test(k)) usageKeys.add(`${e.type} → ${prefix}${k}`);
      if (v && typeof v === "object") scan(v, prefix + k + ".");
    }
  };
  scan(e);
}
if (usageKeys.size) for (const k of usageKeys) console.log("  " + k);
else console.log("  ❌ 本会话无 usage 字段（可能这一轮太短）");

console.log("\n=== ③ 有没有 compaction 痕迹 ===");
const hasCompact = ev.filter((e) => /compact|prune|spill|summar/i.test(e.type));
console.log("  匹配事件:", hasCompact.length ? hasCompact.map((e) => e.type).join(", ") : "❌ 无（本会话未触发压缩）");

console.log("\n=== ④ surfaceOp 取值分布（消息如何被增删改） ===");
const ops = new Map();
for (const e of ev) if (e.surfaceOp) ops.set(e.surfaceOp, (ops.get(e.surfaceOp) ?? 0) + 1);
for (const [k, n] of ops) console.log(`  ${n}x  ${k}`);

console.log("\n=== ⑤ tool/result 的 surfaceOp 与 sourceEventSeqs（可追溯性） ===");
const r = byType("tool/result")[0];
console.log("  data 键:", Object.keys(r.data).join(", "));
console.log("  sourceEventSeqs:", JSON.stringify(r.sourceEventSeqs));
console.log("  surfaceOp:", r.surfaceOp);
console.log("  → 说明 tool/result 能指回触发它的 tool/call（因果链可追溯）");

console.log("\n=== ⑥ agent/inbox/spliced 是什么（消息注入机制） ===");
for (const e of byType("agent/inbox/spliced")) {
  console.log(`  target=${e.data.target} start=${e.data.start} inserted数=${e.data.inserted?.length}`);
  console.log(`   inserted[0].content: ${JSON.stringify(e.data.inserted?.[0]?.content).slice(0, 120)}`);
}

console.log("\n=== ⑦ request/header 里存了什么（对记忆至关重要） ===");
const rh = byType("request/header")[0];
console.log("  data.header 键:", Object.keys(rh.data.header).join(", "));
console.log("  tools 数量:", rh.data.header.tools?.length);
console.log("  messages 是否也在里面:", "messages" in (rh.data.header ?? {}) ? "是" : "否");
console.log("  config:", JSON.stringify(rh.data.header.config));

console.log("\n=== ⑧ 用 deriveMessages 的思路重建历史需要哪些事件 ===");
console.log("  按出现顺序的事件类型序列（去重相邻）:");
const seq = [];
for (const e of ev) if (seq[seq.length - 1] !== e.type) seq.push(e.type);
console.log("   " + seq.join(" → "));

console.log("\n=== ⑨ 时间跨度 ===");
const t0 = ev[0].createdAt ?? ev[0].time;
const times = ev.map((e) => e.time ?? e.createdAt).filter(Boolean);
console.log("  首个时间:", new Date(Math.min(...times)).toISOString());
console.log("  末个时间:", new Date(Math.max(...times)).toISOString());
console.log("  跨度(秒):", ((Math.max(...times) - Math.min(...times)) / 1000).toFixed(1));
