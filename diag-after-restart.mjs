/**
 * 重启后诊断：工作记忆插件到底有没有加载？有没有注入？
 * 只观察，不修改。
 */
import fs from "node:fs";
import path from "node:path";

const WS = "D:\\文档\\deepseek-harness\\default-workspace";
const PROJ = "C:\\Users\\85448\\.dsh\\storages\\session_projcache\\sessions";

console.log("=== 1. WORKING.md 是否被生成（插件加载的直接证据）===");
const entry = path.join(WS, ".dsh", "WORKING.md");
if (fs.existsSync(entry)) {
  console.log("  ✅ 存在");
  console.log("  ---- 内容 ----");
  console.log(fs.readFileSync(entry, "utf8").split("\n").map((l) => "  " + l).join("\n"));
} else {
  console.log("  ❌ 不存在 → 工作记忆插件的 agent/pre-step 没有跑到，或插件没挂载");
}

console.log("\n=== 2. .dsh/work 下的会话目录 ===");
const work = path.join(WS, ".dsh", "work");
if (fs.existsSync(work)) {
  for (const d of fs.readdirSync(work, { withFileTypes: true })) {
    const p = path.join(work, d.name);
    if (d.isDirectory()) {
      const files = fs.readdirSync(p).map((f) => `${f}(${fs.statSync(path.join(p, f)).size}B)`);
      console.log(`  [目录] ${d.name}`);
      console.log(`          ${files.join(", ")}`);
    } else {
      console.log(`  ${d.name}`);
    }
  }
} else {
  console.log("  （.dsh/work 不存在）");
}

console.log("\n=== 3. 最近活跃的会话 id（按投影缓存修改时间）===");
const files = fs.readdirSync(PROJ).filter((f) => f.endsWith(".json"));
const rows = files.map((f) => ({ f, m: fs.statSync(path.join(PROJ, f)).mtimeMs })).sort((a, b) => b.m - a.m);
for (const r of rows.slice(0, 5)) {
  console.log(`  ${new Date(r.m).toLocaleString("zh-CN")}  ${r.f}`);
}

console.log("\n=== 4. 我预置的那个会话文件夹，是否仍是当前会话 ===");
const seeded = "session-b50d5537-da93-4704-b2d0-0429dad12493.json";
const newest = rows[0];
if (newest.f === seeded) {
  console.log("  ✅ 当前会话仍是预置的那个 → 文件夹名是对的，问题在别处");
} else {
  console.log(`  ⚠️ 当前会话已变为 ${newest.f.replace(".json", "")}`);
  console.log(`     预置的是 ${seeded.replace(".json", "")}`);
  console.log("     → 会话 id 变了，这正是我警告的风险");
}
