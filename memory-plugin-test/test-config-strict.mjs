/**
 * 用真实 schemastery 测试 bundle patch 给出的确切 config，
 * 并检验 ~standard 校验是否严格（未知字段是否被拒）。
 * 若 patch 的 config 校验失败，bundle 层会被丢弃 → 插件不挂载。
 */
import z from "file:///D:/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/dsh-source/node_modules/@deepseek-ai/schemastery/lib/index.mjs";

const Config = z.object({
  maxInject: z.natural().min(1).default(24),
  maxEntryChars: z.natural().min(1).default(500),
  mirror: z.boolean().default(true),
  mirrorPath: z.string(),
});

const cases = {
  "bundle patch 的确切输入": { maxInject: 24, maxEntryChars: 500, mirror: true },
  "空对象": {},
  "含未知字段": { maxInject: 1, 未知字段: "x" },
  "maxInject 为 0（违反 min(1)）": { maxInject: 0 },
  "maxInject 为字符串": { maxInject: "24" },
  "maxInject 为负": { maxInject: -1 },
  "mirror 为字符串": { mirror: "true" },
};

console.log("=== 直接调用 Config(input) ===");
for (const [label, input] of Object.entries(cases)) {
  try {
    const out = Config(input);
    console.log(`  ✅ ${label}\n       -> ${JSON.stringify(out)}`);
  } catch (e) {
    console.log(`  ❌ ${label}\n       -> ${e.constructor.name}: ${e.message}`);
  }
}

console.log("\n=== 通过 ~standard 校验（cordis resolveConfig 走的那条路）===");
const std = Config["~standard"];
console.log("  ~standard 类型:", typeof std, std && Object.keys(std).join(", "));
for (const [label, input] of Object.entries(cases)) {
  try {
    const out = std.validate(input);
    const bad = out && out.issues && out.issues.length > 0;
    console.log(`  ${bad ? "❌" : "✅"} ${label}\n       -> ${JSON.stringify(out).slice(0, 200)}`);
  } catch (e) {
    console.log(`  ❌ ${label}\n       -> ${e.constructor.name}: ${e.message}`);
  }
}
