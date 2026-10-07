/**
 * 关键前置验证：从 profile 目录出发，插件能否 import DSH 运行时包与 zod？
 * 这决定插件能不能用官方存储层（而不是像 lark-doc 那样被迫零依赖）。
 */
import fs from "node:fs";
import path from "node:path";

const PROFILE = "C:\\Users\\85448\\.dsh\\profiles\\desktop";
const probe = path.join(PROFILE, "__resolve_probe.mjs");

fs.writeFileSync(
  probe,
  `const specs = [
  "zod",
  "@deepseek-ai/dsh-storage-domain",
  "@deepseek-ai/dsh-storage",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-session-projection",
  "@deepseek-ai/dsh-session-query",
];
for (const s of specs) {
  try {
    const m = await import(s);
    const names = Object.keys(m).slice(0, 8);
    console.log("  OK   " + s.padEnd(44) + " exports: " + names.join(", "));
  } catch (e) {
    console.log("  FAIL " + s.padEnd(44) + " " + String(e.code || e.message).slice(0, 90));
  }
}
`,
  "utf8",
);
console.log("探针已写入:", probe);
