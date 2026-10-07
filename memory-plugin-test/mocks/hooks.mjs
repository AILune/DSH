/**
 * 模块加载钩子：把插件 import 的 DSH 包重定向到本地 mock。
 * 目的：在不启动 DSH 的前提下执行插件的真实代码。
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const MOCKS = path.dirname(fileURLToPath(import.meta.url));

/** 需要被替换的裸模块名 → mock 文件 */
const REDIRECT = new Map([
  ["@deepseek-ai/schemastery", "schemastery.mjs"],
  ["@deepseek-ai/dsh-llm", "dsh-llm.mjs"],
  ["@deepseek-ai/dsh-storage-domain", "dsh-storage-domain.mjs"],
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
