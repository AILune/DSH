/**
 * 逐 zstd 帧解压会话文件（多帧拼接，不是单个 zstd 流）。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const target =
  process.argv[2] ??
  "C:\\Users\\85448\\.dsh\\sessions\\--D-~6587~6863-deepseek-harness-default-workspace--\\session-62d8e1ff-b06d-41b9-afcd-42ace23ae95a\\session.v4.jsonl.zstd";

const buf = fs.readFileSync(target);
console.log(`文件: ${path.basename(target)}  ${buf.length} B`);

// zstd magic: 28 B5 2F FD
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i);
}
console.log(`发现 ${offsets.length} 个 zstd 帧魔数，位置: ${offsets.slice(0, 12).join(", ")}${offsets.length > 12 ? " …" : ""}`);

let out = "";
let ok = 0;
let fail = 0;
for (let k = 0; k < offsets.length; k++) {
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
  const frame = buf.subarray(offsets[k], end);
  try {
    out += zlib.zstdDecompressSync(frame).toString("utf8");
    ok++;
  } catch (e) {
    fail++;
    if (fail <= 3) console.log(`  帧 ${k} (${frame.length} B) 解压失败: ${e.message}`);
  }
}
console.log(`解压成功 ${ok} 帧，失败 ${fail} 帧，共 ${out.length} 字符\n`);

const lines = out.split("\n").filter((l) => l.trim());
console.log(`=== 共 ${lines.length} 行事件 ===\n`);

const types = new Map();
const fieldSets = new Map();
const parsed = [];
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    parsed.push(o);
    const t = o.type ?? "(无 type)";
    types.set(t, (types.get(t) ?? 0) + 1);
    const key = t + " :: " + Object.keys(o).sort().join(",");
    fieldSets.set(key, (fieldSets.get(key) ?? 0) + 1);
  } catch {
    types.set("(解析失败)", (types.get("(解析失败)") ?? 0) + 1);
  }
}

console.log("=== 事件类型分布 ===");
for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${t}`);

console.log("\n=== 事件字段结构（数据模型） ===");
for (const [k, n] of [...fieldSets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(5)}x  ${k}`);
}

console.log("\n=== 各类型抽样一条（截断 400 字符） ===");
const seen = new Set();
for (const o of parsed) {
  const t = o.type ?? "(无)";
  if (seen.has(t)) continue;
  seen.add(t);
  console.log(`\n--- ${t} ---`);
  console.log(JSON.stringify(o).slice(0, 400));
}

// 把解压结果存下来供后续分析
fs.writeFileSync("D:\\文档\\deepseek-harness\\default-workspace\\session-dump.jsonl", out, "utf8");
console.log(`\n完整解压结果已存 -> session-dump.jsonl (${out.length} 字符)`);
