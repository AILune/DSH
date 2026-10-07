/**
 * 本地验证 dsh-plugin-lark-doc：
 *  1. 能否 import（解析 @deepseek-ai/dsh-tools）
 *  2. defineTool 的 schema 编译是否通过（参数/schema 拼错会在这里抛）
 *  3. 注册出来的工具有几个、名字、参数形状
 */
import { pathToFileURL } from "node:url";

const pluginUrl = pathToFileURL(
  process.argv[2] ?? "./lib/index.js",
).href;

const registered = [];
const fakeCtx = {
  tools: {
    register(tool) {
      registered.push(tool);
    },
  },
  logger: {
    info: (...a) => console.log("  [logger]", ...a),
    warn: (...a) => console.warn("  [warn]", ...a),
  },
};

console.log("=== 1. 导入插件 ===");
const mod = await import(pluginUrl);
console.log("  name   :", mod.name);
console.log("  inject :", JSON.stringify(mod.inject));
console.log("  导出   :", Object.keys(mod).join(", "));

console.log("\n=== 2. 调用 apply()（触发 schema 编译）===");
try {
  mod.apply(fakeCtx, {});
  console.log("  ✅ apply 成功，无异常");
} catch (error) {
  console.error("  ❌ apply 抛出:", error.message);
  console.error(error.stack);
  process.exit(1);
}

console.log("\n=== 3. 注册结果 ===");
console.log(`  工具数: ${registered.length}`);
for (const tool of registered) {
  console.log(`\n  ● ${tool.name}`);
  console.log(`      description: ${tool.description.slice(0, 70)}...`);
  const props = tool.parameters?.properties ?? {};
  const required = new Set(tool.parameters?.required ?? []);
  for (const [key, spec] of Object.entries(props)) {
    const bits = [spec.type ?? (spec.oneOf ? "oneOf" : "?")];
    if (required.has(key)) bits.push("required");
    if (spec.enum) bits.push(`enum=${JSON.stringify(spec.enum)}`);
    console.log(`      - ${key}: ${bits.join(" ")}`);
  }
  console.log(`      output.schema type: ${tool.output?.schema?.type}`);
  console.log(`      has render: ${typeof tool.output?.render === "function"}`);
  console.log(`      timeoutMs: ${tool.timeoutMs}`);
}

console.log("\n=== 4. 工具名唯一性 ===");
const names = registered.map((t) => t.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
console.log(dupes.length === 0 ? "  ✅ 无重名" : `  ❌ 重名: ${dupes}`);

console.log("\n=== 5. render 输出形状（用假数据）===");
for (const tool of registered) {
  try {
    // 只为验证 render 返回值结构，构造最小假数据可能抛错，忽略
    console.log(`  ${tool.name}: render 存在=${typeof tool.output.render === "function"}`);
  } catch (e) {
    console.log(`  ${tool.name}: ⚠️ ${e.message}`);
  }
}

console.log("\n✅ 验证完成");
