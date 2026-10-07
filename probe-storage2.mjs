/**
 * 看会话级 storage 文件的真实结构，并理清 storage 与 session 的对应关系。
 */
import fs from "node:fs";
import path from "node:path";

const SD = "C:\\Users\\85448\\.dsh\\storages";
const SES = "C:\\Users\\85448\\.dsh\\sessions";

console.log("=== storages 目录 ===");
const storageFiles = fs.readdirSync(SD).filter((f) => f.endsWith(".json"));
for (const f of storageFiles) console.log(`  ${String(fs.statSync(path.join(SD, f)).size).padStart(7)} B  ${f}`);

console.log("\n=== sessions 目录（对比哪些会话有 storage）===");
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl.zstd")) out.push(path.basename(path.dirname(p)));
  }
  return out;
}
const sessionDirs = walk(SES);
for (const d of sessionDirs) {
  const hasStorage = storageFiles.includes(`${d}.json`);
  console.log(`  ${hasStorage ? "✅有storage" : "❌无storage"}  ${d}`);
}

console.log("\n=== 一个会话级 storage 的完整结构 ===");
const pick = storageFiles.find((f) => f.endsWith(".json") && f !== "workspace.json");
const o = JSON.parse(fs.readFileSync(path.join(SD, pick), "utf8"));
console.log("文件:", pick);
console.log("unit:", JSON.stringify(o.unit));
console.log("顶层键:", Object.keys(o).join(", "));
console.log("global:", JSON.stringify(o.global, null, 2).slice(0, 500));
console.log("\ntables:");
for (const [tname, t] of Object.entries(o.tables ?? {})) {
  const rows = Object.keys(t);
  console.log(`  【${tname}】${rows.length} 行`);
  const first = t[rows[0]];
  if (first) {
    console.log(`     字段: ${Object.keys(first).join(", ")}`);
    console.log(`     样例: ${JSON.stringify(first).slice(0, 400)}`);
  }
}
