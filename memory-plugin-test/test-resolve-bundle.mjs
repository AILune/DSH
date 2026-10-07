/**
 * 复现 dsh-app-boot 的 resolveBundleDir 逻辑：
 *   for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
 *     const dir = packageDirFromAnchor(anchor, packageName);
 *     if (dir !== void 0) return dir;      // 第一个命中就返回，不再校验是否存在
 *   }
 * 如果 installAnchor（app.asar 内）先命中一个不存在的路径，bundle 就会被跳过。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const PKG = "dsh-plugin-memory";
const PROFILE = "C:\\Users\\85448\\.dsh\\profiles\\desktop";

/** 尽力模拟 packageDirFromAnchor：返回包目录或 undefined */
function packageDirFromAnchor(anchor, packageName) {
  try {
    const req = createRequire(anchor);
    const entry = req.resolve(`${packageName}/package.json`);
    return path.dirname(entry);
  } catch (e) {
    return { error: e.code ?? e.message };
  }
}

const anchors = [
  ["installAnchor (模拟 app.asar 内)", "D:\\DSH\\resources\\app.asar\\package.json"],
  ["installAnchor (未打包)", "D:\\DSH\\resources\\app.asar.unpacked\\package.json"],
  ["profileDir/package.json", path.join(PROFILE, "package.json")],
  ["dsh-source/package.json（可用镜像）", "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\package.json"],
];

console.log("=== packageDirFromAnchor 各锚点结果 ===");
for (const [label, anchor] of anchors) {
  const exists = fs.existsSync(anchor);
  const r = packageDirFromAnchor(anchor, PKG);
  if (typeof r === "string") {
    console.log(`  ⚠️  ${label}`);
    console.log(`       锚点存在: ${exists}`);
    console.log(`       -> 命中目录: ${r}`);
    console.log(`       -> 该目录真实存在: ${fs.existsSync(r) ? "✅" : "❌ 不存在！（bundle 会在这里被跳过）"}`);
  } else {
    console.log(`  ❌ ${label}  (锚点存在: ${exists})  -> 未命中: ${r.error}`);
  }
}

console.log("\n=== 直接确认：Node 能否从各锚点解析到插件 ===");
for (const [label, anchor] of anchors) {
  if (!fs.existsSync(anchor)) {
    console.log(`  （跳过 ${label}：锚点文件不存在）`);
    continue;
  }
  try {
    const req = createRequire(anchor);
    console.log(`  ✅ ${label} -> ${req.resolve(PKG)}`);
  } catch (e) {
    console.log(`  ❌ ${label} -> ${e.code}`);
  }
}

console.log("\n=== asar 内是否真的有这个包（若 installAnchor 命中将指向 asar 内路径）===");
console.log("  D:\\DSH\\resources\\app.asar 是文件，内部路径只能用 asar 感知的 fs 访问；");
console.log("  普通 Node 下 'D:\\\\DSH\\\\resources\\\\app.asar\\\\node_modules\\\\...' 会 ENOENT。");
