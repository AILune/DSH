/**
 * 这个脚本会被放进 profile 目录执行，从而使裸说明符 "dsh-plugin-lark-doc"
 * 的解析基准与 DSH loader 完全一致（baseUrl = profile 目录，见 Include L133）。
 */
import fs from "node:fs";

const specifier = "dsh-plugin-lark-doc";

console.log("=== 0. 解析基准确认 ===");
console.log("  本脚本位置:", import.meta.url);
console.log("  解析基准应是 profile 目录");

console.log("\n=== 1. 按 DSH loader 的方式 import ===");
let mod;
try {
  mod = await import(specifier);
  console.log("  ✅ import 成功");
} catch (error) {
  console.log("  ❌ import 失败:", error.code);
  console.log("  ", error.message);
  process.exit(1);
}

console.log("\n=== 2. Cordis 插件契约 ===");
console.log("  name   :", JSON.stringify(mod.name));
console.log("  inject :", JSON.stringify(mod.inject));
console.log("  apply  :", typeof mod.apply);

console.log("\n=== 3. 走一遍 apply ===");
const registered = [];
const fakeCtx = {
  tools: {
    register: (d) => {
      registered.push(d);
      return () => {};
    },
  },
  logger: { info: (fmt, ...a) => console.log("    [logger]", fmt, ...a), warn: () => {} },
};

try {
  mod.apply(fakeCtx, { timeoutMs: 180000, identity: "user" });
} catch (error) {
  console.log("  ❌ apply 失败:", error.message);
  process.exit(1);
}

console.log("\n=== 4. 注册结果 ===");
console.log("  工具数:", registered.length);
for (const d of registered) {
  const checks = {
    name: typeof d.name === "string" && d.name !== "",
    params: d.parameters?.type === "object",
    render: typeof d.output?.render === "function",
    schema: d.output?.schema?.type === "object",
    execute: typeof d.execute === "function",
    timeout: Number.isFinite(d.timeoutMs) && d.timeoutMs > 0,
  };
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(`  ● ${d.name}: ${bad.length === 0 ? "✅" : "❌ " + bad.join(",")}`);
}

const ok = registered.length === 5 && registered.every((d) => typeof d.execute === "function");
console.log("\n" + (ok ? "✅ DSH 加载路径模拟完全成功" : "❌ 存在问题"));
process.exit(ok ? 0 : 1);
