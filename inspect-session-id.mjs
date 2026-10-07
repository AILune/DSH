/**
 * 查明当前会话 id 的确切形式，以及是否有会话标题可用。
 * 只打印结构与少量短字段，避免刷屏或泄露隐私内容。
 */
import fs from "node:fs";
import path from "node:path";

const DIR = "C:\\Users\\85448\\.dsh\\storages\\session_projcache\\sessions";
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
const withTime = FILES.map((f) => ({ f, m: fs.statSync(path.join(DIR, f)).mtimeMs })).sort((a, b) => b.m - a.m);
const target = withTime[0];
console.log("最新投影缓存文件:", target.f);

const raw = JSON.parse(fs.readFileSync(path.join(DIR, target.f), "utf8"));
console.log("\n顶层键:", Object.keys(raw).join(", "));

function short(v) {
  if (typeof v === "string") return v.length > 80 ? `"${v.slice(0, 80)}…"(${v.length}字)` : `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  if (Array.isArray(v)) return `[${v.length} 项]`;
  if (typeof v === "object") return `{${Object.keys(v).slice(0, 8).join(", ")}}`;
  return typeof v;
}

console.log("\n=== 第一层 ===");
for (const [k, v] of Object.entries(raw)) console.log(`  ${k}: ${short(v)}`);

// 找 id / title 相关字段
console.log("\n=== 与 id / title 相关的字段 ===");
const seen = new Set();
function walk(obj, prefix, depth) {
  if (depth > 3 || obj === null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (seen.has(p)) continue;
    if (/^(id|sessionId|title|name|slug|cwd)$/i.test(k) || /session/i.test(k)) {
      seen.add(p);
      console.log(`  ${p} = ${short(v)}`);
    }
    if (typeof v === "object") walk(v, p, depth + 1);
  }
}
walk(raw, "", 0);
