/**
 * 1) 把偏好层被坏计数冲高的 injectCount 归零（纯统计字段，不影响功能）
 * 2) 确认工作记忆的种子文件完好
 */
import fs from "node:fs";
import path from "node:path";

const ENTRIES = "C:\\Users\\85448\\.dsh\\storages\\memory\\entries";

console.log("=== 偏好层：归零 injectCount ===");
const files = fs.readdirSync(ENTRIES).filter((f) => f.endsWith(".json"));
for (const f of files) {
  const p = path.join(ENTRIES, f);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const rec = raw.record ?? raw;
  const before = rec.injectCount;
  rec.injectCount = 0;
  rec.lastInjectedAt = 0;
  fs.writeFileSync(p, JSON.stringify({ version: raw.version ?? 1, record: rec }, null, 2) + "\n", "utf8");
  console.log(`  ${f}`);
  console.log(`    injectCount: ${before} → 0`);
}

console.log("\n=== 工作记忆：种子文件 ===");
const WS = "D:\\文档\\deepseek-harness\\default-workspace";
const dir = path.join(WS, ".dsh", "work", "session-b50d5537-da93-4704-b2d0-0429dad12493");
for (const f of ["session-state.json", "handoff.md"]) {
  const p = path.join(dir, f);
  console.log(`  ${fs.existsSync(p) ? "✅" : "❌"} ${f}  ${fs.existsSync(p) ? fs.statSync(p).size + " B" : "缺失"}`);
}
const st = JSON.parse(fs.readFileSync(path.join(dir, "session-state.json"), "utf8"));
console.log(`  会话 id  : ${st.session.id}`);
console.log(`  active   : ${st.activeDemandId}`);
console.log(`  需求数   : ${st.demands.length}（${st.demands.map((d) => `${d.id}:${d.status}`).join(", ")}）`);

const entry = path.join(WS, ".dsh", "WORKING.md");
console.log(`\n  WORKING.md: ${fs.existsSync(entry) ? "❌ 已存在（应由插件生成，需删除）" : "✅ 不存在，留给重启后由插件生成"}`);
