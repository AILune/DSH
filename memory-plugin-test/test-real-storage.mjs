/**
 * 用真实的 dsh-storage-json 后端验证 per-record 落盘行为：
 *  - 是否懒创建（open 后无域目录，首次写入才出现）
 *  - 目录布局是否为 <root>/memory/entries/<key>.json
 *  - 重新打开能否读回（真持久化，而非内存假象）
 *
 * 这补上 mock 测试覆盖不到的环节：真实后端 + 真实路径 + 真实原子写。
 * 使用临时目录，不碰用户真实的 ~/.dsh/storages。
 */
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const REAL = "D:/文档/deepseek-harness/default-workspace/dsh-source/node_modules/@deepseek-ai";
const { JsonStorageBackend } = await import(`file:///${REAL}/dsh-storage-json/lib/index.js`);

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (detail !== undefined) console.log(`       ${detail}`);
  ok ? pass++ : fail++;
};

const root = await mkdtemp(path.join(tmpdir(), "memory-store-"));
console.log("=== 临时存储根（模拟 ~/.dsh/storages）===");
console.log("  ", root);

/** 与插件完全一致的 descriptor（来自 defineDomain + descriptorOf） */
const DESCRIPTOR = {
  name: "memory",
  version: 1,
  tables: ["entries"],
  hasGlobal: false,
  layout: "per-record",
};

const backend = new JsonStorageBackend(root);

console.log("\n=== 1. open 之后目录状态（验证懒创建）===");
const unit = await backend.kv.open(DESCRIPTOR);
check("open 后存储根已创建", fs.existsSync(root));
check(
  "open 后域目录 memory/ 尚不存在（懒创建）",
  !fs.existsSync(path.join(root, "memory")),
  fs.existsSync(path.join(root, "memory")) ? "❌ 已存在" : "✅ 不存在，符合 loadPerRecordState 的'缺失即空单元'契约",
);

console.log("\n=== 2. 写入一条记录（与插件的记录形状一致）===");
const record = {
  text: "测试记忆：飞书招聘表用「简历评估中」",
  kind: "working",
  scope: "global",
  tags: ["飞书", "Base"],
  evidence: "user-stated",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  injectCount: 0,
};
await unit.putRecord("entries", "global_test-key", record);

const domainDir = path.join(root, "memory");
const entriesDir = path.join(domainDir, "entries");
check("写入后域目录已创建", fs.existsSync(domainDir), domainDir);
check("写入后 entries 表目录已创建", fs.existsSync(entriesDir), entriesDir);

const files = await readdir(entriesDir);
check("记录文件已落盘（1 个）", files.length === 1, files);
check("文件名即 key", files[0] === "global_test-key.json", files[0]);

const raw = await readFile(path.join(entriesDir, files[0]), "utf8");
console.log("       落盘内容:");
console.log(raw.split("\n").map((l) => "         " + l).join("\n"));

console.log("\n=== 3. 关闭并重新打开（验证真持久化）===");
await unit.close();
check("关闭后 backend 释放了 unit", true);

const unit2 = await backend.kv.open(DESCRIPTOR);
const snap = await unit2.loadAll();
const rec = snap?.tables?.entries?.["global_test-key"];
check("重新加载后记录仍在（真持久化）", rec !== undefined, rec);
check("text 字段往返正确", rec?.text === record.text, rec?.text);
check("tags 数组往返正确", Array.isArray(rec?.tags) && rec.tags.length === 2, rec?.tags);
check("evidence 往返正确", rec?.evidence === "user-stated", rec?.evidence);
check("kind/scope 往返正确", rec?.kind === "working" && rec?.scope === "global", `${rec?.kind}/${rec?.scope}`);

console.log("\n=== 4. 同一 unit 不能重复打开（域单开契约）===");
let dup = false;
try {
  await backend.kv.open(DESCRIPTOR);
} catch (e) {
  dup = /already open/.test(e.message);
}
check("重复打开被拒绝", dup);

await unit2.close();
await backend.close();
await rm(root, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅ 真实存储层全部通过" : "❌ 有失败"} —— 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
