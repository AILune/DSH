/**
 * 核对文章点名的"能力"在 DSH 里是否已经内建。
 * 严格匹配：每个插件给出"必须命中"的特征词，逐条判定并打印实际命中的包名。
 */
const fs = require("node:fs");

const B = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\node_modules\\@deepseek-ai";
const all = fs.readdirSync(B);

/** 在包名中查找：所有特征词都必须出现（AND），不区分大小写 */
function findStrict(words) {
  return all.filter((n) => {
    const l = n.toLowerCase();
    return words.every((w) => l.includes(w.toLowerCase()));
  });
}

const groups = [
  ["🥇 基础能力", [
    ["ModLens 图片识别", ["modlens"]],
    ["dsh-at-file (@ 引用文件)", ["at-file"]],
    ["dsh-paste-input (粘贴拖拽)", ["paste"]],
    ["dsh-office (Office 读写)", ["office"]],
    ["dsh-browser-panel (内嵌浏览器)", ["browser"]],
    ["dsh-computer-use (桌面操作)", ["computer"]],
  ]],
  ["🥈 体验增强", [
    ["safe-find-dsh-plugins (插件查找)", ["find-plugin"]],
    ["dsh-web-ui (看板/Git/Token)", ["web-ui"]],
    ["dsh-genui (图表组件)", ["genui", "gen-ui"]],
    ["dsh-turn-rewind (一键回退)", ["rewind"]],
    ["dsh-message-edit (编辑消息)", ["message-edit"]],
  ]],
  ["🥉 进阶玩法", [
    ["dsh-agent-teams (多 Agent)", ["agent-team"]],
    ["dsh-memory-evolve (长期记忆)", ["memory"]],
    ["dsh-llm-fallbacks (模型切换)", ["fallback"]],
    ["dsh-feishu-bot (飞书机器人)", ["feishu", "lark"]],
  ]],
];

// 单项可能有多组写法，任一命中即算存在
function evalItem(label, wordSets) {
  const hits = new Set();
  for (const ws of wordSets) for (const h of findStrict(ws)) hits.add(h);
  return { label, hits: [...hits] };
}

let missing = [];
for (const [tier, items] of groups) {
  console.log(`\n【${tier}】`);
  for (const [label, ...wordSets] of items) {
    const { hits } = evalItem(label, wordSets);
    if (hits.length) {
      console.log(`  ✅ ${label}`);
      console.log(`       ${hits.join(", ")}`);
    } else {
      console.log(`  ❌ ${label}  —— 安装包中无此名称`);
      missing.push(label);
    }
  }
}

console.log(`\n=== 结论：${missing.length} / 15 在安装包中无同名插件 ===`);
for (const m of missing) console.log("   " + m);

console.log("\n=== 自带核心能力包 ===");
const byPrefix = (p) => all.filter((n) => n.startsWith(p));
for (const p of ["dsh-tool-", "dsh-skill-", "dsh-llm-", "dsh-client-ui-", "dsh-experimental-"]) {
  const hit = byPrefix(p);
  console.log(`  ${p.padEnd(18)} ${String(hit.length).padStart(3)} 个`);
}
console.log("\n  dsh-tool-* :", byPrefix("dsh-tool-").join(", "));
console.log("\n  dsh-skill-*:", byPrefix("dsh-skill-").join(", "));
console.log("  dsh-llm-*  :", byPrefix("dsh-llm-").join(", "));
console.log("\n  experimental:", byPrefix("dsh-experimental-").join(", "));
