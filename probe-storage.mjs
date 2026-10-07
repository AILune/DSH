/**
 * 用字节级检查判断 workspace.json 的中文是否真的损坏。
 * PowerShell 的 Get-Content 默认按 GBK 解码 UTF-8，极易误报。
 */
import fs from "node:fs";

const f = "C:\\Users\\85448\\.dsh\\storages\\workspace.json";
const buf = fs.readFileSync(f);

console.log("=== 字节级诊断 ===");
console.log("文件大小:", buf.length, "B");
console.log("有 BOM:", buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? "是（可疑）" : "否");

// 找 "path" 字段的原始字节
const idx = buf.indexOf(Buffer.from('"path"'));
console.log('\n"path" 字段附近的原始字节 (hex):');
const slice = buf.subarray(idx, idx + 60);
console.log("  " + slice.toString("hex").replace(/(..)/g, "$1 ").trim());

console.log("\n=== 按 UTF-8 解码（DSH/Node 的读法）===");
const text = buf.toString("utf8");
const m = text.match(/"path"\s*:\s*"([^"]*)"/);
console.log("  解出:", JSON.stringify(m?.[1]));
console.log("  含义正确（'文档'）:", m?.[1]?.includes("文档") ? "✅ 是" : "❌ 否");

console.log("\n=== JSON 是否可正常解析 ===");
try {
  const o = JSON.parse(text);
  const p = Object.values(o.tables.workspaces)[0].path;
  console.log("  ✅ 解析成功");
  console.log("  工作区路径:", JSON.stringify(p));
  console.log("  路径以 'D:\\文档' 开头:", p.startsWith("D:\\文档") ? "✅" : "❌");
  console.log("  其他会话 id 数:", Object.values(o.tables.workspaces)[0].sessionIds.length);
} catch (e) {
  console.log("  ❌ 解析失败:", e.message);
}

console.log("\n=== 结论 ===");
const good = m?.[1]?.includes("文档");
console.log(
  good
    ? "文件本身完好 —— 之前看到的乱码是 PowerShell 5.1 用 GBK 解码 UTF-8 造成的显示假象，DSH 侧无问题。"
    : "文件确实损坏 —— 需要修复。",
);

// 顺带看一个会话级 storage 文件的结构
console.log("\n=== 会话级 storage 文件结构（session-62d8e1ff）===");
const s2 = "C:\\Users\\85448\\.dsh\\storages\\session-62d8e1ff-b06d-41b9-afcd-42ace23ae95a.json";
const o2 = JSON.parse(fs.readFileSync(s2, "utf8"));
console.log("  unit:", JSON.stringify(o2.unit));
console.log("  顶层键:", Object.keys(o2).join(", "));
console.log("  tables 的表名:", Object.keys(o2.tables ?? {}).join(", "));
for (const [tname, t] of Object.entries(o2.tables ?? {})) {
  console.log(`    ${tname}: ${Object.keys(t).length} 行`);
  const first = Object.values(t)[0];
  if (first) console.log(`      首行字段: ${Object.keys(first).join(", ")}`);
}
