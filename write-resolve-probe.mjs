/**
 * 关键前置验证：从 profile 目录出发，插件能否 import DSH 运行时包与 zod？
 *
 * 上次 lark-doc 插件失败是因为从工作区 import 拿不到 app.asar 里的包。
 * 但 dsh-session-projection-cache 自己就在 profile 里跑，且 import 了 zod 和
 * @deepseek-ai/dsh-storage-domain —— 说明从 profile 锚点是可行的。
 * 这次必须实测，因为它决定插件能不能用官方存储层。
 */
const PROFILE = "C:\\Users\\85448\\.dsh\\profiles\\desktop";
const probe = require("node:path").join(PROFILE, "__resolve_probe.mjs");
require("node:fs").writeFileSync(
  probe,
  `
const specs = [
  "zod",
  "@deepseek-ai/dsh-storage-domain",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-session-projection",
];
for (const s of specs) {
  try {
    const m = await import(s);
    const names = Object.keys(m).slice(0, 6);
    console.log("  OK   " + s.padEnd(42) + " exports: " + names.join(", "));
  } catch (e) {
    console.log("  FAIL " + s.padEnd(42) + " " + (e.code || e.message).slice(0, 80));
  }
}
`,
  "utf8",
);
console.log("探针已写入 profile，用 DSH 同款 Node 执行：\n");
