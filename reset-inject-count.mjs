/**
 * 重置偏好层的 injectCount，并补上 injectedSessions 凭据。
 *
 * 背景：旧实现在内存里用 Set 去重（进程重启即清零），导致同一会话被反复计数。
 * 实测：偏好 createdAt = 2026-10-04 11:36:52，而本工作区的会话日志里
 * 只有 4 个会话的最后写入晚于该时刻 —— 也就是说最多只有 4 个会话可能被注入过，
 * 但计数已经涨到 8。
 *
 * 本脚本把这 4 个会话 id 写进 injectedSessions，并把 injectCount 重置为 4。
 * 依据是文件系统事实（会话日志 mtime），不是猜测。
 *
 * 安全策略：备份 → 断言 → 写入 → 回读校验。任一步不过就不写。
 */
import fs from "node:fs";
import path from "node:path";

const ENTRIES_DIR = "C:\\Users\\85448\\.dsh\\storages\\memory\\entries";
const MIRROR = "C:\\Users\\85448\\.dsh\\memory\\MEMORY.md";
const SESSIONS_DIR = "C:\\Users\\85448\\.dsh\\sessions\\--D-~6587~6863-deepseek-harness-default-workspace--";
const PREF_CREATED_AT = 1791085012264; // 偏好条目 createdAt

const fail = (m) => {
  console.error(`❌ ${m} —— 未写入`);
  process.exit(1);
};

/* ---- 1. 从会话日志反推「可能被注入过」的会话 ---- */
if (!fs.existsSync(SESSIONS_DIR)) fail(`会话目录不存在：${SESSIONS_DIR}`);
const eligible = fs
  .readdirSync(SESSIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = path.join(SESSIONS_DIR, d.name);
    const zst = fs.readdirSync(dir).find((f) => f.endsWith(".zstd"));
    const mtime = zst ? fs.statSync(path.join(dir, zst)).mtimeMs : fs.statSync(dir).mtimeMs;
    return { id: d.name, mtime };
  })
  .filter((s) => s.mtime > PREF_CREATED_AT)
  .sort((a, b) => a.mtime - b.mtime);

console.log("=== 依据：最后写入晚于偏好 createdAt 的会话 ===");
console.log(`  偏好 createdAt = ${new Date(PREF_CREATED_AT).toLocaleString()}`);
for (const s of eligible) console.log(`  ✓ ${s.id}   ${new Date(s.mtime).toLocaleString()}`);
console.log(`  → 共 ${eligible.length} 个会话可能被注入过`);

if (eligible.length === 0) fail("反推不出任何会话，说明推理前提有问题");
const ids = eligible.map((s) => s.id);
if (new Set(ids).size !== ids.length) fail("会话 id 有重复");

/* ---- 2. 改条目 ---- */
const files = fs.readdirSync(ENTRIES_DIR).filter((f) => f.endsWith(".json"));
if (files.length === 0) fail("没有条目文件");

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const changes = [];

for (const f of files) {
  const p = path.join(ENTRIES_DIR, f);
  const raw = fs.readFileSync(p, "utf8");
  const obj = JSON.parse(raw);
  const rec = obj?.record;
  if (rec === undefined) fail(`${f} 没有 record 字段`);
  if (typeof rec.injectCount !== "number") fail(`${f} 的 injectCount 不是数字`);

  fs.copyFileSync(p, `${p}.pre-reset-${stamp}`);
  const before = rec.injectCount;
  rec.injectCount = ids.length;
  rec.injectedSessions = [...ids];
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");

  const back = JSON.parse(fs.readFileSync(p, "utf8")).record;
  if (back.injectCount !== ids.length) fail(`${f} 回读 injectCount 不对`);
  if (JSON.stringify(back.injectedSessions) !== JSON.stringify(ids)) fail(`${f} 回读 injectedSessions 不对`);
  changes.push({ f, before, after: back.injectCount });
}

console.log("\n=== 条目已重置 ===");
for (const c of changes) console.log(`  ${c.f}:  injectCount ${c.before} → ${c.after}  + injectedSessions[${ids.length}]`);

/* ---- 3. 重新生成镜像（与插件渲染逻辑一致）---- */
function injectionCell(e) {
  const count = e.injectCount ?? 0;
  const short = (e.injectedSessions ?? []).map((s) => String(s).replace(/^session-/, "").slice(0, 8));
  if (count === 0) return "0";
  if (short.length === 0) return `${count}（历史计数，无 id 记录）`;
  const shown = short.slice(0, 5).join(", ");
  return `${count}（${shown}${short.length > 5 ? `, +${short.length - 5}` : ""}）`;
}

const all = files.map((f) => {
  const { record } = JSON.parse(fs.readFileSync(path.join(ENTRIES_DIR, f), "utf8"));
  return { id: f.replace(/\.json$/, ""), ...record };
});
all.sort((a, b) => b.updatedAt - a.updatedAt);
const doc = [
  "# MEMORY.md —— 跨会话记忆镜像（只读）",
  "",
  `<!-- 由 dsh-plugin-memory 自动生成于 ${new Date().toISOString()} -->`,
  "<!-- 这是一个只读镜像；权威副本在 domain 文件里，直接编辑本文件不会生效。 -->",
  "<!-- 要删除某条记忆，用 memory_delete 工具，或告诉我。 -->",
  "",
  `共 ${all.length} 条。`,
  "",
  "> 「注入会话数」= 这条记忆被注入过的**不同会话**数；括号里是会话 id 的前 8 位，可据此人工核验。",
  "> 去重依据是持久化的 `injectedSessions` 列表（不是内存里的 Set），所以进程重启、插件热加载都不会重复计数。",
  "> 权威副本（含完整会话 id）在 domain 文件里；本文件是只读镜像。",
  "",
  "| id | 类型 | 范围 | 正文 | 证据 | 注入会话数（id 前缀） |",
  "|---|---|---|---|---|---|",
  ...all.map(
    (e) =>
      `| \`${e.id}\` | ${e.kind} | ${e.scope} | ${e.text.replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${e.evidence} | ${injectionCell(e)} |`,
  ),
  "",
].join("\n");

if (fs.existsSync(MIRROR)) fs.copyFileSync(MIRROR, `${MIRROR}.pre-reset-${stamp}`);
fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
fs.writeFileSync(MIRROR, doc, "utf8");
console.log(`\n=== 镜像已重生成 ===\n  ${MIRROR}`);
console.log("\n✅ 重置完成（备份后缀 .pre-reset-" + stamp + "）");
