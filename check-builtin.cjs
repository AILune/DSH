/**
 * 核对文章点名的"能力"在 DSH 里是否已经内建。
 * 依据：本会话实际可用的工具集 + 287 个 @deepseek-ai 包。
 */
const fs = require("node:fs");
const path = require("node:path");

const B = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\node_modules\\@deepseek-ai";
const all = fs.readdirSync(B);

function find(...pats) {
  return all.filter((n) => pats.some((p) => n.toLowerCase().includes(p.toLowerCase())));
}
function show(label, pats) {
  const hit = find(...pats);
  console.log(`  ${hit.length ? "✅" : "❌"} ${label}`);
  if (hit.length) console.log(`       ${hit.slice(0, 6).join(", ")}${hit.length > 6 ? ` …(+${hit.length - 6})` : ""}`);
}

console.log("=== 文章 15 项 vs DSH 实际提供方 ===");

console.log("\n【🥇 基础能力】");
show("ModLens 图片识别", "modlens", "vision", "image");
show("@ 引用文件 (dsh-at-file)", "at-file", "mention", "file-mention");
show("粘贴/拖拽文件 (dsh-paste-input)", "paste", "attachment", "upload");
show("Office 读写 (dsh-office)", "office");
show("内嵌浏览器 (dsh-browser-panel)", "browser", "playwright", "puppeteer");
show("桌面操作 (dsh-computer-use)", "computer-use", "computer_use", "screen", "desktop");

console.log("\n【🥈 体验增强】");
show("插件查找 (safe-find-dsh-plugins)", "find-plugin", "marketplace", "registry", "inventory");
show("任务看板/Git/Token (dsh-web-ui)", "web-app", "client-ui", "task-board", "kanban");
show("图表组件渲染 (dsh-genui)", "genui", "gen-ui", "chart", "render-ui");
show("一键回退 (dsh-turn-rewind)", "rewind", "rollback", "revert", "checkpoint");
show("编辑消息重发 (dsh-message-edit)", "message-edit", "edit-message", "regenerate");

console.log("\n【🥉 进阶玩法】");
show("多 Agent 协作 (dsh-agent-teams)", "agent-team", "agent_team", "team");
show("跨会话记忆 (dsh-memory-evolve)", "memory", "evolve");
show("模型故障切换 (dsh-llm-fallbacks)", "llm-fallback", "llm-fallback", "fallback");
show("飞书机器人 (dsh-feishu-bot)", "feishu", "lark");

console.log("\n=== 本安装自带的核心能力包（抽样） ===");
const core = ["dsh-tool-", "dsh-skill-", "dsh-llm-", "dsh-agent-", "dsh-client-ui-"];
for (const p of core) {
  const hit = find(p);
  console.log(`  ${p.padEnd(14)} ${hit.length} 个`);
}
console.log("\n  tool-* 明细:", find("dsh-tool-").join(", "));
console.log("  skill-* 明细:", find("dsh-skill-").join(", "));
