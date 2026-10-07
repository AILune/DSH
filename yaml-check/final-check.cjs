/**
 * 最终校验：重建后的 cordis.patch.yml 是否 YAML 合法、结构正确、内容无损。
 */
const fs = require("fs");
const yaml = require("js-yaml");

const patch = "C:\\Users\\85448\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const backup = process.argv[2];

const bytes = fs.readFileSync(patch);
console.log("=== 编码 ===");
console.log("  首 3 字节:", [...bytes.subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
console.log("  有 BOM   :", bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);

let doc;
try {
  doc = yaml.load(bytes.toString("utf8"));
} catch (e) {
  console.log("\n❌ YAML 解析失败:", e.message);
  process.exit(1);
}

console.log("\n=== YAML 解析 ===");
console.log("  ✅ 合法，顶层条目数:", doc.length);
doc.forEach((entry, i) => {
  if (entry && entry.insert) {
    console.log(`  [${i}] insert -> ${JSON.stringify(entry.insert.map((x) => x.id ?? x.name))}`);
  } else {
    console.log(`  [${i}] id=${entry?.id}  name=${entry?.name}`);
  }
});

console.log("\n=== 挂载条目详情 ===");
const last = doc[doc.length - 1];
const row = last?.insert?.[0];
console.log("  id     :", JSON.stringify(row?.id));
console.log("  name   :", JSON.stringify(row?.name));
console.log("  config :", JSON.stringify(row?.config));

console.log("\n=== 中文完整性 ===");
const text = bytes.toString("utf8");
const checks = [
  ["实验室 DeepSeek", text.includes("实验室 DeepSeek")],
  ["无乱码 瀹為獙", !text.includes("瀹為獙")],
];
checks.forEach(([label, ok]) => console.log(`  ${ok ? "✅" : "❌"} ${label}`));

console.log("\n=== 与原备份差异（应只有追加）===");
const bak = fs.readFileSync(backup).toString("utf8").replace(/\r\n/g, "\n");
const cur = text.replace(/\r\n/g, "\n");
const bakLines = bak.trimEnd().split("\n");
const curLines = cur.trimEnd().split("\n");
let diffs = 0;
for (let i = 0; i < bakLines.length; i++) {
  if (bakLines[i] !== curLines[i]) {
    diffs++;
    console.log(`  L${i + 1} 备份: ${JSON.stringify(bakLines[i])}`);
    console.log(`  L${i + 1} 当前: ${JSON.stringify(curLines[i])}`);
  }
}
console.log(`  原有 ${bakLines.length} 行中差异 ${diffs} 处`);
console.log(`  新增 ${curLines.length - bakLines.length} 行`);

const added = curLines.length - bakLines.length;
const ok = diffs === 0 && added === 7;
console.log(`  → 判据: 原有行差异=${diffs}（须为 0），新增行=${added}（须为 7）`);
console.log("\n" + (ok ? "✅ 配置重建完全正确" : "❌ 存在问题"));
process.exit(ok ? 0 : 1);
