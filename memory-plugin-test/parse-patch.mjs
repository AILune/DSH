/**
 * 用真实的 js-yaml 解析我的 cordis.patch.yml，并检查结构是否符合
 * loadOverlayPatches 的期望（顶层数组，元素带 insert -> 行数组）。
 */
import yaml from "file:///D:/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/yaml-check/node_modules/js-yaml/dist/js-yaml.cjs.js";
import fs from "node:fs";

const files = {
  "插件自身 cordis.patch.yml": "D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-memory\\cordis.patch.yml",
  "部署副本 cordis.patch.yml": "C:\\Users\\85448\\.dsh\\profiles\\desktop\\node_modules\\dsh-plugin-memory\\cordis.patch.yml",
};

for (const [label, file] of Object.entries(files)) {
  console.log(`=== ${label} ===`);
  console.log(`  ${file}`);
  const raw = fs.readFileSync(file);
  console.log(`  字节数: ${raw.length}  首字节: ${raw.slice(0, 3).toString("hex")}`);
  const text = raw.toString("utf8");
  try {
    const parsed = yaml.load(text);
    console.log(`  ✅ 解析成功`);
    console.log(`  顶层类型: ${Array.isArray(parsed) ? "数组" : typeof parsed}  长度: ${parsed?.length}`);
    console.log(`  内容: ${JSON.stringify(parsed, null, 2).split("\n").map((l) => "    " + l).join("\n").trim()}`);
    // 结构检查
    let ok = Array.isArray(parsed);
    if (ok) {
      for (const entry of parsed) {
        if (entry === null || typeof entry !== "object") { ok = false; console.log("  ❌ 元素不是对象:", entry); continue; }
        if (!Array.isArray(entry.insert)) { ok = false; console.log("  ❌ 元素缺少 insert 数组:", Object.keys(entry)); continue; }
        for (const row of entry.insert) {
          if (row === null || typeof row !== "object") { ok = false; console.log("  ❌ insert 行不是对象"); continue; }
          if (typeof row.id !== "string" && typeof row.name !== "string") { ok = false; console.log("  ❌ insert 行既无 id 也无 name:", Object.keys(row)); }
        }
      }
    }
    console.log(`  结构检查: ${ok ? "✅ 符合 loadOverlayPatches 期望" : "❌ 不符合"}`);
  } catch (e) {
    console.log(`  ❌ 解析失败: ${e.name}: ${e.message}`);
    if (e.mark) console.log(`     位置: 行 ${e.mark.line + 1} 列 ${e.mark.column + 1}`);
  }
  console.log();
}
