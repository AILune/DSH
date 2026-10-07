/**
 * 用现有的 defineTool 版本作输入，导出每个工具真正的 JSON Schema 字面量。
 * 这样重写后的零依赖插件用的是"证明过"的 schema，而不是我手写的近似。
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const registered = new Map();
const fakeCtx = {
  tools: { register: (tool) => registered.set(tool.name, tool) },
  logger: { info: () => {}, warn: () => {} },
};

const mod = await import(
  pathToFileURL(
    "D:/文档/deepseek-harness/default-workspace/dsh-plugin-lark-doc/lib/index.js",
  ).href,
);
mod.apply(fakeCtx, {});

const out = {};
for (const [name, tool] of registered) {
  out[name] = {
    description: tool.description,
    parameters: tool.parameters,
    outputSchema: tool.output.schema,
    timeoutMs: tool.timeoutMs,
  };
}

const dest =
  "D:/文档/deepseek-harness/default-workspace/compiled-schemas.json";
fs.writeFileSync(dest, JSON.stringify(out, null, 2), "utf8");

console.log("已导出", Object.keys(out).length, "个工具的 schema ->", dest);
for (const [name, spec] of Object.entries(out)) {
  console.log(`\n● ${name}`);
  console.log("  parameters:", JSON.stringify(spec.parameters));
  console.log("  outputSchema:", JSON.stringify(spec.outputSchema).slice(0, 220));
}
