import { pathToFileURL } from "node:url";
import path from "node:path";
const REAL = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\node_modules\\@deepseek-ai";
const MOCKS = "D:\\文档\\deepseek-harness\\default-workspace\\memory-plugin-test\\mocks";
const MAP = new Map([
  ["@deepseek-ai/schemastery", path.join(REAL, "schemastery", "lib", "index.mjs")],
  ["@deepseek-ai/dsh-storage-domain", path.join(REAL, "dsh-storage-domain", "lib", "index.js")],
  ["@deepseek-ai/dsh-llm", path.join(MOCKS, "dsh-llm.mjs")],
  ["@deepseek-ai/dsh-session-projection", path.join(MOCKS, "dsh-session-projection.mjs")],
  ["@deepseek-ai/dsh-tools", path.join(MOCKS, "dsh-tools.mjs")],
]);
export async function resolve(spec, ctx, next) {
  const f = MAP.get(spec);
  if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
  return next(spec, ctx);
}
