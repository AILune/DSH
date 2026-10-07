/**
 * 直接调用真实的 dsh-app-boot 导出，复现 DSH 启动时的 profile 加载，
 * 打印 skippedBundles —— 这是"插件为什么没挂上"的权威答案。
 *
 * loadProfileDirectory 会把不可读/不兼容的 bundle 静默跳过（只记进 skippedBundles），
 * 所以这是唯一能看到原因的方式。
 */
const boot = await import(
  "file:///D:/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/dsh-source/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js"
);

console.log("=== 1. 运行时版本 ===");
let runtimeVersion;
try {
  runtimeVersion = boot.getDshRuntimeVersion();
  console.log("  getDshRuntimeVersion() =", runtimeVersion);
} catch (e) {
  console.log("  ❌ 读不到运行时版本:", e.message);
}

const PROFILE = "C:\\Users\\85448\\.dsh\\profiles\\desktop";
const INSTALL_ANCHOR = "D:\\DSH\\resources\\app.asar\\package.json";

console.log("\n=== 2. 两个候选 installAnchor 是否存在 ===");
const fs = await import("node:fs");
for (const a of [
  INSTALL_ANCHOR,
  "D:\\DSH\\resources\\app.asar.unpacked\\package.json",
  "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\package.json",
]) {
  console.log(`  ${fs.existsSync(a) ? "✅" : "❌"} ${a}`);
}

console.log("\n=== 3. 真实加载 profile（用 dsh-source 作为 install 锚点）===");
const anchor = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\package.json";
try {
  const loaded = boot.loadProfileDirectory("probe", PROFILE, anchor);
  console.log("  profile 名:", loaded.name);
  console.log("  成功加载的 bundle 层:");
  for (const layer of loaded.layers) {
    console.log(`    ✅ ${layer.packageName}`);
    console.log(`         patchPaths: ${JSON.stringify(layer.patchPaths, null, 0)}`);
    console.log(`         patches   : ${layer.patches.length} 条`);
  }
  if (loaded.skippedBundles.length === 0) {
    console.log("  被跳过的 bundle: （无）");
  } else {
    console.log("  被跳过的 bundle:");
    for (const s of loaded.skippedBundles) {
      console.log(`    ❌ ${s.packageName}`);
      console.log(`         原因: ${s.reason}`);
    }
  }
} catch (e) {
  console.log("  ❌ 加载抛错:", e.message);
}

console.log("\n=== 4. 单独校验我插件的兼容性 ===");
const manifest = JSON.parse(fs.readFileSync(`${PROFILE}\\node_modules\\dsh-plugin-memory\\package.json`, "utf8"));
try {
  const issue = boot.evaluatePluginCompatibility(manifest, {}, runtimeVersion);
  console.log("  evaluatePluginCompatibility ->", issue === undefined ? "✅ 无问题" : JSON.stringify(issue, null, 2));
} catch (e) {
  console.log("  ❌ 抛错:", e.message);
}
