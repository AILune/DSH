/**
 * 检查最大的会话文件：是否触发过 compaction？压缩后原文还在不在？
 * 这决定了"记忆丢失"到底发生在哪一层。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = "C:\\Users\\85448\\.dsh\\sessions";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl.zstd")) out.push({ p, size: fs.statSync(p).size });
  }
  return out;
}

function decode(file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  for (let i = 0; i + 4 <= buf.length; i++)
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
  let out = "";
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString("utf8"); } catch {}
  }
  return out;
}

const files = walk(ROOT).sort((a, b) => b.size - a.size);
console.log(`共 ${files.length} 个会话，按大小排序前 6：`);
for (const { p, size } of files.slice(0, 6)) console.log(`  ${String(size).padStart(9)} B  ${path.basename(path.dirname(p))}`);
console.log();

// 分析最大的几个
for (const { p, size } of files.slice(0, 4)) {
  const text = decode(p);
  const lines = text.split("\n").filter((l) => l.trim());
  const types = new Map();
  let parsed = [];
  for (const l of lines) {
    try { const o = JSON.parse(l); parsed.push(o); types.set(o.type, (types.get(o.type) ?? 0) + 1); } catch {}
  }
  const totalChars = text.length;
  const assistantChars = parsed.filter(e => e.type === "assistant/message")
    .reduce((s, e) => s + JSON.stringify(e).length, 0);
  const toolResultChars = parsed.filter(e => e.type === "tool/result")
    .reduce((s, e) => s + JSON.stringify(e).length, 0);

  console.log(`━━━ ${path.basename(path.dirname(p))}`);
  console.log(`    ${size} B(压缩) → ${totalChars} 字符(明文), ${lines.length} 事件`);
  const interesting = [...types.entries()].filter(([t]) =>
    /compact|prune|spill|summar|truncat|snip|surface|remove|replace|delete/i.test(t));
  console.log(`    压缩/裁剪类事件: ${interesting.length ? interesting.map(([t, n]) => `${t}×${n}`).join(", ") : "❌ 无"}`);
  console.log(`    全部类型: ${[...types.entries()].map(([t, n]) => `${t}×${n}`).join(", ")}`);
  console.log(`    体积占比: assistant/message ${(assistantChars / totalChars * 100).toFixed(1)}%  tool/result ${(toolResultChars / totalChars * 100).toFixed(1)}%`);

  // 检查首条 user/message 是否还在（压缩若发生，早期消息可能被移除）
  const userMsgs = parsed.filter(e => e.type === "user/message");
  const first = userMsgs[0];
  console.log(`    user/message 条数: ${userMsgs.length}`);
  if (first) {
    const t = first.data?.content?.[0]?.text ?? "";
    console.log(`    首条用户消息仍完整保留: ${t.length > 40 ? "是（前80字：" + t.slice(0, 80).replace(/\n/g, " ") + "）" : "内容很短"}`);
  }
  // surfaceOp 分布：remove 之类说明消息被移出上下文
  const ops = new Map();
  for (const e of parsed) if (e.surfaceOp) ops.set(e.surfaceOp, (ops.get(e.surfaceOp) ?? 0) + 1);
  console.log(`    surfaceOp: ${[...ops.entries()].map(([k, n]) => `${k}×${n}`).join(", ")}`);
  console.log();
}
