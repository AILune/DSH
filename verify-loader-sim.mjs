/**
 * 精确模拟 DSH loader 对挂载条目的加载：
 *   baseUrl = profile 目录（来自 Include 构造器 L133）
 *   exports = await loader.import("dsh-plugin-lark-doc", baseUrl, {})
 *
 * 这里的 import 从 profile 目录发起，与 DSH 行为一致。
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const profileDir = "C:\\Users\\85448\\.dsh\\profiles\\desktop";
const baseUrl = pathToFileURL(profileDir + "\\").href; // 对应 Include L133
const specifier = "dsh-plugin-lark-doc";

console.log("=== 模拟参数（与 Include L133 一致）===");
console.log("  baseUrl  :", baseUrl);
console.log("  specifier:", specifier);

console.log("\n=== 1. 从 profile 目录解析并 import ===");
// Node 的裸说明符解析基于"父模块"，故用一个位于 profile 目录的合成模块
const syntheticModule = pathToFileURL(profileDir + "\\__synthetic_loader_anchor__.mjs").href;
let mod;
try {
  mod = await import(specifier + "?probe=" + Date.now());
} catch (error) {
  console.log("  ❌ import 失败:", error.code, error.message);
  console.log((error.stack ?? "").split("\n").slice(0, 6).join("\n"));
  process.exit(1);
}
console.log("  ✅ import 成功");

console.log("\n=== 2. 检查 Cordis 插件契约 ===");
console.log("  name   :", JSON.stringify(mod.name));
console.log("  inject :", JSON.stringify(mod.inject));
console.log("  apply  :", typeof mod.apply);
const contractOk =
  typeof mod.name === "string" &&
  Array.isArray(mod.inject) &&
  typeof mod.apply === "function";
console.log("  契约完整:", contractOk ? "✅ 是" : "❌ 否");

console.log("\n=== 3. 用假 ctx 走一遍 apply（模拟 DSH 注册工具）===");
const registered = [];
const fakeCtx = {
  tools: { register: (d) => { registered.push(d); return () => {}; } },
  logger: { info: (fmt, ...a) => console.log("    [logger]", fmt, ...a), warn: () => {} },
};
try {
  mod.apply(fakeCtx, { timeoutMs: 180000, identity: "user" });
  console.log("  ✅ apply 正常，注册工具数:", registered.length);
  registered.forEach((d) => console.log(`      ● ${d.name}`));
} catch (error) {
  console.log("  ❌ apply 失败:", error.message);
  process.exit(1);
}

console.log("\n=== 4. 工具定义是否满足 ctx.tools.register 的硬性要求 ===");
let allOk = true;
for (const d of registered) {
  const checks = [
    ["name 是非空字符串", typeof d.name === "string" && d.name !== ""],
    ["parameters 是 JSON Schema object", d.parameters?.type === "object"],
    ["output 是对象", d.output !== null && typeof d.output === "object"],
    ["output.render 是函数", typeof d.output?.render === "function"],
    ["output.schema 是 object", d.output?.schema?.type === "object"],
    ["execute 是函数", typeof d.execute === "function"],
    ["timeoutMs 是正数", Number.isFinite(d.timeoutMs) && d.timeoutMs > 0],
  ];
  const bad = checks.filter(([, ok]) => !ok);
  console.log(`  ● ${d.name}: ${bad.length === 0 ? "✅ 全部满足" : "❌ " + bad.map(([l]) => l).join(", ")}`);
  if (bad.length > 0) allOk = false;
}

console.log("\n" + (contractOk && allOk ? "✅ 模拟加载完全成功——DSH 应能正常加载此插件" : "❌ 存在问题"));
process.exit(contractOk && allOk ? 0 : 1);
