/**
 * 去掉 cordis.patch.yml 的 BOM，并校验结果与"预期内容"完全一致。
 * 用 Node 写文件以保证精确的字节控制（无 BOM、LF 行尾）。
 */
import fs from "node:fs";

const patch = "C:\\Users\\85448\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const backup = process.argv[2];

const raw = fs.readFileSync(patch);
console.log("=== 修复前 ===");
console.log("  首 6 字节:", [...raw.subarray(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
console.log("  有 BOM   :", raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf);
console.log("  字节数   :", raw.length);

// 剥离 BOM
let body = raw;
if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
  body = body.subarray(3);
}
const text = body.toString("utf8");

// 规范化行尾为 LF，确保幂等
const normalized = text.replace(/\r\n/g, "\n");
fs.writeFileSync(patch, Buffer.from(normalized, "utf8"));

const after = fs.readFileSync(patch);
console.log("\n=== 修复后 ===");
console.log("  首 6 字节:", [...after.subarray(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
console.log("  有 BOM   :", after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf);
console.log("  字节数   :", after.length);

console.log("\n=== 与备份对比（应只多出我追加的挂载条目）===");
if (backup) {
  const bak = fs.readFileSync(backup).toString("utf8").replace(/\r\n/g, "\n");
  const bakHasBom = fs.readFileSync(backup)[0] === 0xef;
  console.log("  备份有 BOM:", bakHasBom);
  const current = normalized;
  if (current.startsWith(bak.trimEnd())) {
    const added = current.slice(bak.trimEnd().length);
    console.log("  ✅ 备份内容是当前内容的前缀，唯一新增部分:");
    console.log(added.split("\n").map((l) => "      " + l).join("\n"));
  } else {
    console.log("  ⚠️ 备份不是前缀，逐行 diff:");
    const a = bak.trimEnd().split("\n");
    const b = current.trimEnd().split("\n");
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[i] !== b[i]) {
        console.log(`      L${i + 1} 备份: ${JSON.stringify(a[i])}`);
        console.log(`      L${i + 1} 当前: ${JSON.stringify(b[i])}`);
      }
    }
  }
}
