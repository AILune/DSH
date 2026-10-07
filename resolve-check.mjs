/**
 * 模拟 DSH 的插件解析：能否从 profile 目录解析出插件包并 import。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const profileDir = "C:\\Users\\85448\\.dsh\\profiles\\desktop";
const packageName = "dsh-plugin-lark-doc";
const anchor = `${profileDir}\\package.json`;

const require = createRequire(anchor);

console.log("=== 1. createRequire 锚点 ===");
console.log("  anchor:", anchor);
const paths = require.resolve.paths(packageName) ?? [];
console.log("  解析路径（前 4）:");
paths.slice(0, 4).forEach((p) => console.log("    ", p));

console.log("\n=== 2. 解析 package.json ===");
let manifestPath;
try {
  manifestPath = require.resolve(`${packageName}/package.json`);
  console.log("  ✅ 解析到:", manifestPath);
} catch (error) {
  console.log("  ❌ 解析失败:", error.code, error.message);
  process.exit(1);
}

console.log("\n=== 3. 读取 manifest ===");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
console.log("  name    :", manifest.name);
console.log("  version :", manifest.version);
console.log("  main    :", manifest.main);
console.log("  exports :", JSON.stringify(manifest.exports));

console.log("\n=== 4. peerDependencies 兼容性检查 ===");
const peers = Object.keys(manifest.peerDependencies ?? {});
const dshPeers = peers.filter(
  (n) => n === "@deepseek-ai/dsh" || n.startsWith("@deepseek-ai/dsh-"),
);
console.log("  全部 peers :", JSON.stringify(peers));
console.log("  会被校验的 :", JSON.stringify(dshPeers));
console.log(
  dshPeers.length === 0
    ? "  ✅ 无机内校验的 peer"
    : `  ⚠️ ${dshPeers.length} 个会被校验`,
);

console.log("\n=== 5. 真正 import 插件模块 ===");
const entry = require.resolve(packageName);
console.log("  入口:", entry);
try {
  const mod = await import(pathToFileURL(entry).href);
  console.log("  ✅ import 成功");
  console.log("  导出  :", Object.keys(mod).join(", "));
  console.log("  name  :", mod.name);
  console.log("  inject:", JSON.stringify(mod.inject));
} catch (error) {
  console.log("  ❌ import 失败:", error.message);
  console.log((error.stack ?? "").split("\n").slice(0, 8).join("\n"));
  process.exit(1);
}

console.log("\n✅ 插件可被 DSH 正常解析与加载");
