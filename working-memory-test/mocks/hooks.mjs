/**
 * 模块加载钩子：把插件 import 的 DSH 包重定向到本地 mock。
 * 工作记忆插件不依赖 dsh-storage-domain（状态存在工作区文件里），故不映射它。
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const MOCKS = path.dirname(fileURLToPath(import.meta.url));

const REDIRECT = new Map([
  ["@deepseek-ai/schemastery", "schemastery.mjs"],
  ["@deepseek-ai/dsh-llm", "dsh-llm.mjs"],
  ["@deepseek-ai/dsh-session-projection", "dsh-session-projection.mjs"],
  ["@deepseek-ai/dsh-tools", "dsh-tools.mjs"],
]);

export async function resolve(specifier, context, next) {
  const file = REDIRECT.get(specifier);
  if (file !== undefined) {
    return { url: pathToFileURL(path.join(MOCKS, file)).href, shortCircuit: true };
  }
  return next(specifier, context);
}
