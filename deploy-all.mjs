/**
 * 一条命令把三个插件部署到本机的 DSH profile。
 *
 * 用法：
 *   node deploy-all.mjs                     自动探测 profile（桌面端为 desktop）
 *   node deploy-all.mjs --profile desktop   指定 profile
 *   node deploy-all.mjs 备注                备注进入备份文件名
 *
 * 为什么需要一个统一入口：每台机器上「装插件」都要做同样三件事，
 * 分散成三个脚本容易漏跑一个 —— 而漏跑的表现是「工具静默消失」：
 * 不报装载错误，只是调用返回 unknown tool（本项目踩过这个坑）。
 *
 * 子脚本各自带完整校验（编码 / YAML / exports / 补丁层字节级未变等），
 * 这里用 stdio:'inherit' 串联执行，任一失败即中止并返回非零。
 * 脚本幂等，可重复运行。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { WORKSPACE_ROOT, resolveDshHome, resolveProfileTarget, parseArgs } from "./dsh-paths.mjs";

const { profile, stamp } = parseArgs();

console.log("=== 环境 ===");
console.log("  DSH home :", resolveDshHome());

let target;
try {
  target = resolveProfileTarget({ profile });
} catch (e) {
  console.error("\n❌ " + e.message);
  process.exit(1);
}
console.log("  profile  :", target.dir);
console.log("  仓库根   :", WORKSPACE_ROOT);
console.log("  备份备注 :", stamp);

const SCRIPTS = ["deploy-memory.mjs", "deploy-working-memory.mjs", "deploy-lark-doc.mjs"];
const done = [];
const failed = [];

for (const script of SCRIPTS) {
  console.log(`\n${"─".repeat(64)}\n▶ ${script}\n${"─".repeat(64)}`);
  const result = spawnSync(process.execPath, [path.join(WORKSPACE_ROOT, script), "--profile", target.name, stamp], {
    stdio: "inherit",
  });
  if (result.status === 0) {
    done.push(script);
  } else {
    failed.push(script);
    break; // 一个失败就停，避免留下「装了一半」的中间状态
  }
}

console.log(`\n${"═".repeat(64)}`);
console.log(`通过：${done.length}/${SCRIPTS.length}  ${done.join(", ")}`);
if (failed.length > 0) {
  console.log(`失败：${failed.join(", ")}`);
  console.log("\n❌ 部署中断。修正上面的报错后重跑即可（脚本幂等）。");
  process.exit(1);
}
console.log("✅ 三个插件全部部署完成。");
console.log("\n下一步：重启 DSH 后生效。");
console.log("验证方式：重启后本轮回复上方的运行时上下文里应出现");
console.log("          「常驻规则层：共 N 条偏好（global x / 本工作区 y），本轮注入 m 条 · 版本 v」");
console.log("          那一行 —— 它是偏好层插件成功挂载的直接证据。");
