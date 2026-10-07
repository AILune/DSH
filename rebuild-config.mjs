/**
 * 用备份的原始字节 + 追加的挂载条目，重建 cordis.patch.yml。
 * 全程 Byte 级操作，绝不经过 GBK 解码，确保中文与编码完好。
 */
import fs from "node:fs";

const patch = "C:\\Users\\85448\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const backup = process.argv[2];
const stamp = process.argv[3];

// 1. 先把当前（损坏）版本另存一份，便于追溯
fs.copyFileSync(patch, `${patch}.corrupt-${stamp}`);
console.log("已保存损坏版副本:", `${patch}.corrupt-${stamp}`);

// 2. 读备份的原始字节，确认它没有 BOM 且是 UTF-8
const bakBytes = fs.readFileSync(backup);
const bakHasBom = bakBytes[0] === 0xef && bakBytes[1] === 0xbb && bakBytes[2] === 0xbf;
console.log("\n=== 备份原始字节 ===");
console.log("  字节数 :", bakBytes.length);
console.log("  有 BOM :", bakHasBom);
const bakText = bakBytes.toString("utf8");
console.log("  UTF-8 解码后含中文的行:");
bakText
  .replace(/\r\n/g, "\n")
  .split("\n")
  .forEach((l, i) => {
    if (/[^\x00-\x7F]/.test(l)) console.log(`    L${i + 1}: ${l}`);
  });

// 3. 规范化行尾为 LF，并确保以单个换行结尾
let base = bakText.replace(/\r\n/g, "\n");
if (!base.endsWith("\n")) base += "\n";

// 4. 追加挂载条目
const mountBlock = `
- insert:
    - id: lark-doc
      name: dsh-plugin-lark-doc
      config:
        timeoutMs: 180000
        identity: user
`;
const rebuilt = base + mountBlock;

// 5. 以无 BOM UTF-8 写出
fs.writeFileSync(patch, Buffer.from(rebuilt, "utf8"));

// 6. 校验结果
const after = fs.readFileSync(patch);
const afterText = after.toString("utf8");
console.log("\n=== 重建结果 ===");
console.log("  字节数 :", after.length);
console.log("  有 BOM :", after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf);
console.log("  中文行 :");
afterText.split("\n").forEach((l, i) => {
  if (/[^\x00-\x7F]/.test(l)) console.log(`    L${i + 1}: ${l}`);
});

const restored = afterText.includes("displayName: 实验室 DeepSeek");
console.log("\n  中文已还原:", restored ? "✅ 是" : "❌ 否");

// 7. 确认除追加外与备份完全一致
const afterBody = afterText.slice(0, base.length);
console.log("  备份内容逐字保留:", afterBody === base ? "✅ 是" : "❌ 否");
console.log("  仅追加了挂载条目:", afterText.slice(base.length) === mountBlock ? "✅ 是" : "❌ 否");

process.exit(restored && afterBody === base ? 0 : 1);
