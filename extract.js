const fs = require("fs");
const path = require("path");

const SRC = "D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai";
const DST =
  "D:/文档/deepseek-harness/default-workspace/dsh-source/node_modules/@deepseek-ai";

// 排除：已经解包在磁盘上的 LibreOffice（170MB exe），以及嵌套的第三方 node_modules
const EXCLUDE_PKG = /^libreoffice-kit/;
const EXCLUDE_DIR = new Set(["node_modules"]);

let copied = 0,
  bytes = 0,
  skipped = 0;
const failures = [];

function copyFile(from, to) {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const buf = fs.readFileSync(from);
    fs.writeFileSync(to, buf);
    copied++;
    bytes += buf.length;
  } catch (e) {
    failures.push(`${from}  ->  ${e.message}`);
  }
}

function walk(d, outDir) {
  let entries;
  try {
    entries = fs.readdirSync(d, { withFileTypes: true });
  } catch (e) {
    failures.push(`readdir ${d}: ${e.message}`);
    return;
  }
  for (const e of entries) {
    const from = d + "/" + e.name;
    const to = outDir + "/" + e.name;
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.has(e.name)) {
        skipped++;
        continue;
      }
      walk(from, to);
    } else {
      copyFile(from, to);
    }
  }
}

const pkgs = fs.readdirSync(SRC).sort();
const kept = [];
for (const p of pkgs) {
  if (EXCLUDE_PKG.test(p)) {
    skipped++;
    continue;
  }
  kept.push(p);
  walk(SRC + "/" + p, DST + "/" + p);
}

console.log("解包完成");
console.log("  包数      : " + kept.length + " / " + pkgs.length);
console.log("  文件数    : " + copied);
console.log("  总字节    : " + bytes + "  (" + (bytes / 1048576).toFixed(1) + " MB)");
console.log("  跳过项    : " + skipped);
console.log("  失败      : " + failures.length);
if (failures.length) {
  console.log("\n前 15 条失败：");
  failures.slice(0, 15).forEach((f) => console.log("  " + f));
}
console.log("\n输出目录: " + DST);
