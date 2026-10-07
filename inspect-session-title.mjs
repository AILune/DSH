import fs from "node:fs";
import path from "node:path";

const F = "C:\\Users\\85448\\.dsh\\storages\\session_projcache\\sessions\\session-b50d5537-da93-4704-b2d0-0429dad12493.json";
const raw = JSON.parse(fs.readFileSync(F, "utf8"));
const r = raw.record;

console.log("=== identity ===");
for (const [k, v] of Object.entries(r.identity ?? {})) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  console.log(`  ${k} = ${s.length > 120 ? s.slice(0, 120) + "…" : s}`);
}

for (const key of ["title", "sessionListMetadata"]) {
  const row = r.rows?.[key];
  console.log(`\n=== rows.${key} ===`);
  if (row === undefined) {
    console.log("  （无）");
    continue;
  }
  console.log("  ver:", row.ver, " seq:", row.seq);
  const v = row.val;
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  console.log("  val:", s.length > 600 ? s.slice(0, 600) + "…" : s);
}
