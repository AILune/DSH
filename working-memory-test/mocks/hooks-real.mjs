/**
 * 让 @deepseek-ai/schemastery 走真实实现（其余仍是 mock），
 * 以便用真 schemastery 校验插件的 Config 语义。
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const REAL = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\node_modules\\@deepseek-ai";
const MOCKS = "D:\\文档\\deepseek-harness\\default-workspace\\working-memory-test\\mocks";

const MAP = new Map([
  ["@deepseek-ai/schemastery", path.join(REAL, "schemastery", "lib", "index.mjs")],
  ["@deepseek-ai/dsh-llm", path.join(MOCKS, "dsh-llm.mjs")],
  ["@deepseek-ai/dsh-session-projection", path.join(MOCKS, "dsh-session-projection.mjs")],
  ["@deepseek-ai/dsh-tools", path.join(MOCKS, "dsh-tools.mjs")],
]);

export async function resolve(spec, ctx, next) {
  const f = MAP.get(spec);
  if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
  return next(spec, ctx);
}
