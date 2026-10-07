/**
 * 验证零依赖版插件：
 *  1. 能否加载（不应有任何外部 import）
 *  2. apply() 是否注册 5 个工具并返回 disposer
 *  3. 参数/输出 schema 是否与 defineTool 版导出的逐字一致
 *  4. 自带参数校验是否按预期拦截
 *  5. disposer 是否能注销
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const PLUGIN = "D:/文档/deepseek-harness/default-workspace/dsh-plugin-lark-doc/lib/index.js";
const GOLDEN =
  "D:/文档/deepseek-harness/default-workspace/compiled-schemas.json";

const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));

const registered = new Map();
const disposers = [];
const fakeCtx = {
  tools: {
    register(definition) {
      if (registered.has(definition.name)) {
        throw new Error(`duplicate tool name: ${definition.name}`);
      }
      registered.set(definition.name, definition);
      const dispose = () => registered.delete(definition.name);
      disposers.push(dispose);
      return dispose;
    },
  },
  logger: { info: (...a) => console.log("  [logger]", ...a), warn: () => {} },
};

console.log("=== 1. 加载插件 ===");
const mod = await import(pathToFileURL(PLUGIN).href);
console.log("  导出:", Object.keys(mod).join(", "));
console.log("  name:", mod.name, "| inject:", JSON.stringify(mod.inject));
if (mod.Config !== undefined) {
  console.log("  ⚠️ 仍导出 Config");
} else {
  console.log("  ✅ 无 Config 导出（Cordis 会跳过 config 校验，符合预期）");
}

console.log("\n=== 2. apply() ===");
let disposeAll;
try {
  disposeAll = mod.apply(fakeCtx, {});
  console.log("  注册工具数:", registered.size);
  console.log("  apply 返回类型:", typeof disposeAll);
} catch (error) {
  console.error("  ❌ apply 失败:", error.message);
  console.error(error.stack);
  process.exit(1);
}

console.log("\n=== 3. schema 与 defineTool 版逐字比对 ===");
let allMatch = true;
for (const [name, spec] of Object.entries(golden)) {
  const actual = registered.get(name);
  if (!actual) {
    console.log(`  ❌ 缺少工具 ${name}`);
    allMatch = false;
    continue;
  }
  const paramMatch =
    JSON.stringify(actual.parameters) === JSON.stringify(spec.parameters);
  const outMatch =
    JSON.stringify(actual.output.schema) === JSON.stringify(spec.outputSchema);
  const descMatch = actual.description === spec.description;
  const timeoutMatch = actual.timeoutMs === spec.timeoutMs;
  console.log(`  ● ${name}`);
  console.log(`      parameters    一致: ${paramMatch ? "✅" : "❌"}`);
  console.log(`      output.schema 一致: ${outMatch ? "✅" : "❌"}`);
  console.log(`      description   一致: ${descMatch ? "✅" : "❌"}`);
  console.log(`      timeoutMs     一致: ${timeoutMatch ? "✅" : "❌"}`);
  if (!paramMatch) {
    console.log("      期望:", JSON.stringify(spec.parameters));
    console.log("      实际:", JSON.stringify(actual.parameters));
  }
  if (!outMatch) {
    console.log("      期望:", JSON.stringify(spec.outputSchema));
    console.log("      实际:", JSON.stringify(actual.output.schema));
  }
  if (!paramMatch || !outMatch || !descMatch || !timeoutMatch) allMatch = false;
}
console.log(allMatch ? "\n  ✅ 全部逐字一致" : "\n  ❌ 存在差异");

console.log("\n=== 4. render 输出形状 ===");
const renderCases = {
  lark_doc_read: {
    args: { doc: "x" },
    value: { document_id: "D1", revision_id: 7, content: "正文内容" },
  },
  lark_doc_replace: {
    args: { doc: "x", pattern: "a", content: "b" },
    value: { revision_id: 8, result: "success", url: "https://e/x" },
  },
  lark_doc_insert: {
    args: { doc: "x", content: "<p>a</p>" },
    value: {
      revision_id: 9,
      result: "success",
      new_blocks: [{ block_id: "blk1", block_type: "text" }],
    },
  },
  lark_doc_search: {
    args: { query: "q" },
    value: { items: [{ title: "T", url: "https://e/y", type: "docx" }] },
  },
};
for (const [name, { args, value }] of Object.entries(renderCases)) {
  const blocks = registered.get(name).output.render(args, value);
  const ok =
    Array.isArray(blocks) &&
    blocks.length > 0 &&
    blocks.every((b) => b.type === "text" && typeof b.text === "string");
  console.log(`  ${name}: ${ok ? "✅" : "❌"} ${JSON.stringify(blocks[0]?.text?.slice(0, 60))}`);
}

console.log("\n=== 5. 自带参数校验 ===");
const read = registered.get("lark_doc_read");
const cases = [
  ["缺少 required doc", {}, true],
  ["doc 类型错误", { doc: 123 }, true],
  ["enum 非法值", { doc: "x", doc_format: "bogus" }, true],
  ["未知属性", { doc: "x", nope: 1 }, true],
  ["合法参数", { doc: "x" }, false],
];
for (const [label, args, shouldFail] of cases) {
  let failed = false;
  let message = "";
  try {
    // 用 invalid token，校验通过后会真的去调 lark-cli；
    // 我们只关心校验是否抛错，所以捕获一切后看错误种类
    await read.execute(args, { signal: undefined });
  } catch (error) {
    failed = true;
    message = `${error.name}: ${error.message}`;
  }
  const isValidation = failed && message.startsWith("ToolArgsError");
  if (shouldFail) {
    console.log(
      `  ${label}: ${isValidation ? "✅ 被校验拦截" : "❌ 未被拦截"} — ${message.slice(0, 80)}`,
    );
  } else {
    // 合法参数应当越过校验，进入 lark-cli 调用（此处会因 token 无效而失败）
    const passedValidation = !message.startsWith("ToolArgsError");
    console.log(
      `  ${label}: ${passedValidation ? "✅ 通过校验（后续 lark-cli 报错属正常）" : "❌ 被误拦"} — ${message.slice(0, 80)}`,
    );
  }
}

console.log("\n=== 6. disposer 注销 ===");
const before = registered.size;
if (typeof disposeAll === "function") disposeAll();
console.log(`  注销前 ${before} 个 → 注销后 ${registered.size} 个`);
console.log(registered.size === 0 ? "  ✅ disposer 正常" : "  ❌ disposer 未清空");

console.log("\n" + (allMatch ? "✅ 零依赖版验证通过" : "❌ 存在问题"));
process.exit(allMatch ? 0 : 1);
