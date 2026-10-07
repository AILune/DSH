/**
 * 解压真实会话文件，看 DSH 到底持久化了什么 —— 这是设计记忆插件的经验依据。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = "C:\\Users\\85448\\.dsh\\sessions";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl.zstd")) out.push(p);
  }
  return out;
}

const files = walk(ROOT)
  .map((f) => ({ f, size: fs.statSync(f).size, mtime: fs.statSync(f).mtime }))
  .sort((a, b) => b.mtime - a.mtime);

console.log(`找到 ${files.length} 个会话文件，最近 5 个：`);
for (const { f, size } of files.slice(0, 5)) {
  console.log(`  ${String(size).padStart(9)} B  ${path.basename(f)}`);
}

// 挑一个小的来分析（避免解析 2.8MB 的那个）
const target = files.filter((x) => x.size < 200_000).sort((a, b) => b.size - a.size)[0] ?? files[0];
console.log(`\n分析对象: ${path.basename(target.f)}  (${target.size} B)`);

const raw = zlib.zstdDecompressSync(fs.readFileSync(target.f));
const text = raw.toString("utf8");
const lines = text.split("\n").filter((l) => l.trim());
console.log(`解压后 ${raw.length} B, ${lines.length} 行\n`);

// 统计事件类型
const types = new Map();
const parsed = [];
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    parsed.push(o);
    const t = o.type ?? o.kind ?? o.event ?? "(无 type)";
    types.set(t, (types.get(t) ?? 0) + 1);
  } catch {
    types.set("(解析失败)", (types.get("(解析失败)") ?? 0) + 1);
  }
}

console.log("=== 事件类型分布 ===");
for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${t}`);
}

console.log("\n=== 每条事件的所有字段名（看数据模型） ===");
const fieldSets = new Map();
for (const o of parsed) {
  const t = o.type ?? o.kind ?? "(无)";
  const keys = Object.keys(o).sort().join(",");
  fieldSets.set(t + " :: " + keys, (fieldSets.get(t + " :: " + keys) ?? 0) + 1);
}
for (const [k, n] of [...fieldSets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(n).padStart(4)}x  ${k}`);
}

console.log("\n=== header（第一行）完整内容 ===");
console.log(JSON.stringify(parsed[0], null, 2)?.slice(0, 1200));

console.log("\n=== 抽样：各类型各取一条，看实际内容（截断） ===");
const seen = new Set();
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch { continue; }
  const t = o.type ?? o.kind ?? "(无)";
  if (seen.has(t)) continue;
  seen.add(t);
  console.log(`\n--- ${t} ---`);
  console.log(JSON.stringify(o, null, 2).slice(0, 700));
}
