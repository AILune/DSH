const fs = require("fs");
const path = require("path");

const SRC = "D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai";
const names = fs.readdirSync(SRC);

const extSize = new Map();
let total = 0;
const big = [];

function walk(d, pkg) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = d + "/" + e.name;
    if (e.isDirectory()) {
      walk(f, pkg);
    } else {
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      total += st.size;
      const ext = path.extname(e.name).toLowerCase() || "(no ext)";
      extSize.set(ext, (extSize.get(ext) || 0) + st.size);
      big.push({ f: f.replace(SRC + "/", ""), size: st.size });
    }
  }
}

for (const n of names) walk(SRC + "/" + n, n);

console.log("=== 按扩展名统计体积 ===");
[...extSize.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 18)
  .forEach(([ext, size]) =>
    console.log(
      `  ${(ext + "               ").slice(0, 16)} ${(size / 1048576).toFixed(1)} MB`
    )
  );

console.log("\n=== 最大的 12 个文件 ===");
big
  .sort((a, b) => b.size - a.size)
  .slice(0, 12)
  .forEach((x) => console.log(`  ${(x.size / 1048576).toFixed(1)} MB  ${x.f}`));

console.log(`\n总计 ${(total / 1048576).toFixed(1)} MB`);
