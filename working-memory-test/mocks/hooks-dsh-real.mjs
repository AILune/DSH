/**
 * 全真实环境钩子：把插件引用的 DSH 包指向 dsh-source 里的**真实实现**。
 *
 * 与 hooks-real.mjs 的区别：那个把 dsh-llm 换成 mock（够用但会让真实
 * dsh-sandbox 找不到 HarnessError）；本文件全部走真实包，用于需要
 * dsh-tools 真实校验器的契约测试。
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const REAL = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\node_modules\\@deepseek-ai";

/** 包名 → 候选入口（按顺序取第一个存在的） */
const CANDIDATES = {
  "@deepseek-ai/schemastery": ["lib/index.mjs", "lib/index.js"],
  "@deepseek-ai/dsh-llm": ["lib/index.js"],
  "@deepseek-ai/dsh-session-projection": ["lib/index.js"],
  "@deepseek-ai/dsh-tools": ["lib/index.js"],
};

const MAP = new Map();
for (const [spec, rels] of Object.entries(CANDIDATES)) {
  const pkgDir = path.join(REAL, spec.slice("@deepseek-ai/".length));
  for (const rel of rels) {
    const p = path.join(pkgDir, rel);
    if (fs.existsSync(p)) {
      MAP.set(spec, p);
      break;
    }
  }
}

export async function resolve(spec, ctx, next) {
  const f = MAP.get(spec);
  if (f !== undefined) return { url: pathToFileURL(f).href, shortCircuit: true };
  return next(spec, ctx);
}
