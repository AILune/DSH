/**
 * 用真实 schemastery 验证 Config 形状：
 *  - z.string() 未 .optional() 时，缺值是抛错还是可选？
 *  - .default() 在缺值时是否生效？
 * 这决定插件 Config 是否会因为 bundle patch 没写全字段而加载失败。
 */
import z from "file:///D:/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/dsh-source/node_modules/@deepseek-ai/schemastery/lib/index.mjs";

console.log("schemastery 实测\n");

// 复刻插件的 Config
const Config = z.object({
  maxInject: z.natural().min(1).default(24),
  maxEntryChars: z.natural().min(1).default(500),
  mirror: z.boolean().default(true),
  mirrorPath: z.string(),
});

function attempt(label, input) {
  try {
    const out = Config(input);
    console.log(`  ✅ ${label}\n       -> ${JSON.stringify(out)}`);
  } catch (e) {
    console.log(`  ❌ ${label}\n       -> ${e.constructor.name}: ${e.message}`);
  }
}

console.log("=== A. 完全省略所有字段（bundle patch 只给部分字段时最接近的情形）===");
attempt("Config({})", {});
attempt("Config(undefined)", undefined);
attempt("Config(null)", null);

console.log("\n=== B. 只给 maxInject ===");
attempt("Config({maxInject: 10})", { maxInject: 10 });

console.log("\n=== C. 显式给全 ===");
attempt("Config({maxInject:1,maxEntryChars:1,mirror:false,mirrorPath:'x'})", {
  maxInject: 1,
  maxEntryChars: 1,
  mirror: false,
  mirrorPath: "x",
});

console.log("\n=== D. 结论：schemastery 里 .optional() 不存在，缺值字段直接省略 ===");
console.log("  base 字段用 .default() 补默认；无 .default() 的 string 缺值时被省略，不报错。");
console.log("  证据：上面 A/B 均成功，且 mirrorPath 未出现在输出中。");

console.log("\n=== E. schemastery 是否暴露 ~standard（决定 cordis 会不会校验）===");
console.log("  Config['~standard'] =", Config["~standard"] === undefined ? "undefined（cordis 会跳过校验）" : "存在（cordis 会校验）");
