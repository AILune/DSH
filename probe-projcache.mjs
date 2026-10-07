/**
 * 看 projection 缓存格式，以及系统里都注册了哪些 projection key。
 */
import fs from "node:fs";
import path from "node:path";

const PC = "C:\\Users\\85448\\.dsh\\storages\\session_projcache";

for (const f of fs.readdirSync(PC).filter((x) => x.endsWith(".json"))) {
  const o = JSON.parse(fs.readFileSync(path.join(PC, f), "utf8"));
  console.log(`━━━ ${f}`);
  console.log("  顶层键:", Object.keys(o).join(", "));
  if (o.unit) console.log("  unit:", JSON.stringify(o.unit));
  const tables = o.tables ?? o;
  for (const [t, v] of Object.entries(tables)) {
    if (t === "unit" || t === "global") continue;
    const keys = Object.keys(v ?? {});
    console.log(`  表【${t}】${keys.length} 行: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? " …" : ""}`);
    const first = v[keys[0]];
    if (first && typeof first === "object") {
      console.log(`     首行键: ${Object.keys(first).join(", ")}`);
      const s = JSON.stringify(first);
      console.log(`     样例(${s.length}B): ${s.slice(0, 300)}`);
    }
  }
  console.log();
  if (f.startsWith("session-62d8")) break; // 看一个就够
}
