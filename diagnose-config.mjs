/**
 * 诊断：列出当前配置文件里所有非 ASCII 字符及其位置，
 * 与备份对照，判断哪些行被我损坏。
 */
import fs from "node:fs";

const patch = "C:\\Users\\85448\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const backup = process.argv[2];

const cur = fs.readFileSync(patch, "utf8").replace(/\r\n/g, "\n").split("\n");
const bak = fs.readFileSync(backup, "utf8").replace(/\r\n/g, "\n").split("\n");

console.log("=== 当前文件所有含非 ASCII 的行 ===");
cur.forEach((line, i) => {
  if (/[^\x00-\x7F]/.test(line)) {
    console.log(`  L${i + 1}: ${line}`);
  }
});

console.log("\n=== 备份文件所有含非 ASCII 的行 ===");
bak.forEach((line, i) => {
  if (/[^\x00-\x7F]/.test(line)) {
    console.log(`  L${i + 1}: ${line}`);
  }
});

console.log("\n=== 逐行比对（仅列差异，忽略我追加的尾部）===");
const bakBody = bak.slice(0, bak.length); // 备份全长
let diffCount = 0;
for (let i = 0; i < bakBody.length; i++) {
  if (bakBody[i] !== cur[i]) {
    diffCount++;
    console.log(`\n  L${i + 1} 差异:`);
    console.log(`    备份: ${JSON.stringify(bakBody[i])}`);
    console.log(`    当前: ${JSON.stringify(cur[i])}`);
  }
}
console.log(`\n  共 ${diffCount} 处差异（在备份覆盖的行范围内）`);

// 判断是否是 mojibake：把当前行按 latin1 编码回 bytes 再按 utf8 解码
console.log("\n=== 乱码还原可行性检查 ===");
for (let i = 0; i < bakBody.length; i++) {
  if (bakBody[i] === cur[i]) continue;
  const curLine = cur[i] ?? "";
  for (const [label, fn] of [
    ["latin1→utf8", (s) => Buffer.from(s, "latin1").toString("utf8")],
    ["utf8→latin1", (s) => Buffer.from(s, "utf8").toString("latin1")],
  ]) {
    let attempt;
    try {
      attempt = fn(curLine);
    } catch {
      continue;
    }
    if (attempt === bakBody[i]) {
      console.log(`  L${i + 1}: 可用 ${label} 还原 ✅`);
    }
  }
}
