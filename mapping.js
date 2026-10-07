const fs = require("fs");
const R =
  "D:/文档/deepseek-harness/default-workspace/dsh-source/node_modules/@deepseek-ai";

// 从 patch 文本里抽出「id + name 紧邻」的行对
function rows(file) {
  const txt = fs.readFileSync(file, "utf8").split("\n");
  const out = [];
  for (let i = 0; i < txt.length; i++) {
    const m = /^(\s*)-?\s*id:\s*['"]?([A-Za-z0-9_.@/-]+)['"]?\s*$/.exec(txt[i]);
    if (!m) continue;
    const indent = m[1].length;
    const id = m[2];
    // 往后找同级或更深缩进的 name:
    let name = null;
    for (let j = i + 1; j < txt.length; j++) {
      const nm = /^(\s*)name:\s*['"]?([^'"\n]+?)['"]?\s*$/.exec(txt[j]);
      if (nm) {
        name = nm[2].trim();
        break;
      }
      if (/^\s*-?\s*id:/.test(txt[j]) && txt[j].search(/\S/) <= indent) break;
    }
    out.push({ id, name });
  }
  return out;
}

const base = rows(`${R}/dsh-base/cordis.patch.yml`);
const web = rows(`${R}/dsh-web-app/cordis.patch.yml`);

const user = [
  { id: "ui-chat", name: "@deepseek-ai/dsh-client-ui-chat" },
  { id: "ui-settings", name: "@deepseek-ai/dsh-client-ui-settings" },
  { id: "ui-settings-account", name: "@deepseek-ai/dsh-client-ui-settings-account" },
  { id: "llm-deepseek", name: "@deepseek-ai/dsh-llm-deepseek-api-key" },
  { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" },
  { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model" },
  { id: "ui-settings-general", name: "@deepseek-ai/dsh-client-ui-settings-general" },
];

function find(list, id) {
  return list.find((r) => r.id === id);
}

console.log("你的 patch 条目 → 它覆盖的是哪个 bundle 的哪一行\n");
for (const u of user) {
  const b = find(base, u.id);
  const w = find(web, u.id);
  const src = b ? "dsh-base" : w ? "dsh-web-app" : "❌ 不存在";
  const ref = b || w;
  let verdict;
  if (!ref) verdict = "未知目标（会被警告并跳过）";
  else if (ref.name === u.name) verdict = "✅ 命中，且 name 一致";
  else verdict = `⚠️ name 不一致：bundle=${ref.name}`;
  console.log(`  ${u.id}`);
  console.log(`      你的 name : ${u.name}`);
  console.log(`      来源      : ${src}${ref ? "  →  " + ref.name : ""}`);
  console.log(`      判定      : ${verdict}\n`);
}

console.log(`dsh-base 共 ${base.length} 行，dsh-web-app 共 ${web.length} 行`);
