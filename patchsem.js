const fs = require("fs");
const R =
  "D:/文档/deepseek-harness/default-workspace/dsh-source/node_modules/@deepseek-ai";
const s = fs.readFileSync(`${R}/dsh-app-boot/lib/index.js`, "utf8");
const lines = s.split("\n");
const idx = lines.findIndex((l) => /function applyEntryPatches/.test(l));
console.log(`===== applyEntryPatches 实现（第 ${idx + 1} 行起）=====`);
console.log(lines.slice(idx, idx + 100).map((l, i) => `${idx + 1 + i}: ${l}`).join("\n"));
