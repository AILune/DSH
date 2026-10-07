/**
 * 校验修改后的 profile 补丁：
 *  - YAML 是否合法
 *  - 结构是否符合 loader 期望
 *  - 中文 displayName 是否完好（用 Node 读，避开 PowerShell GBK 显示假象）
 *  - 是否无 BOM
 */
import yaml from "file:///D:/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/yaml-check/node_modules/js-yaml/dist/js-yaml.cjs.js";
import fs from "node:fs";

const f = "C:\\Users\\85448\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const raw = fs.readFileSync(f);

console.log("=== 字节层检查 ===");
console.log("  字节数 :", raw.length);
console.log("  首 3 字节:", raw.slice(0, 3).toString("hex"), raw[0] === 0xef ? "❌ 有 BOM" : "✅ 无 BOM");
console.log("  行尾   :", raw.includes(Buffer.from("\r\n")) ? "CRLF" : "LF");

console.log("\n=== YAML 解析 ===");
const parsed = yaml.load(raw.toString("utf8"));
if (!Array.isArray(parsed)) {
  console.log("  ❌ 顶层不是数组");
  process.exit(1);
}
console.log(`  ✅ 顶层数组，${parsed.length} 项`);

console.log("\n=== 逐项结构 ===");
let insertRows = 0;
for (const [i, entry] of parsed.entries()) {
  if (entry?.insert) {
    for (const row of entry.insert) {
      insertRows++;
      console.log(`  [${i}] insert -> id=${row.id}  name=${row.name}`);
    }
  } else {
    console.log(`  [${i}] id=${entry.id}  name=${entry.name}`);
  }
}

console.log("\n=== 关键内容未损坏 ===");
const llm = parsed.find((e) => e.id === "llm-pi-ai");
const dn = llm?.config?.providers?.xdcyber?.displayName;
console.log("  displayName =", JSON.stringify(dn), dn === "实验室 DeepSeek" ? "✅ 中文完好" : "❌ 不匹配");

const memEntry = parsed.find((e) => e.insert?.some((r) => r.id === "memory"));
console.log("  memory 直挂条目:", memEntry ? "✅ 存在" : "❌ 缺失");
const memRow = memEntry?.insert?.find((r) => r.id === "memory");
console.log("  memory 行 name =", memRow?.name, memRow?.name === "dsh-plugin-memory" ? "✅" : "❌");

console.log("\n=== 原有的 7 个配置项是否都在 ===");
for (const want of [
  "ui-chat",
  "ui-settings",
  "ui-settings-account",
  "llm-deepseek",
  "llm-pi-ai",
  "agent-default-model",
  "ui-settings-general",
]) {
  console.log(`  ${parsed.some((e) => e.id === want) ? "✅" : "❌"} ${want}`);
}

console.log(`\n总条目 ${parsed.length}（7 个配置项 + 1 个 insert），insert 行 ${insertRows} 条`);
