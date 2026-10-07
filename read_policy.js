const fs = require("fs");
const p =
  "D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-sandbox/lib/index.js";
const s = fs.readFileSync(p, "utf8");
const idx = s.indexOf("function approveEscalation");
console.log("===== approveEscalation: how the granted mode is consumed =====");
console.log(s.slice(idx, idx + 2100));
