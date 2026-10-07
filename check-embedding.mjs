/**
 * 查 DSH 的 LLM 服务：有没有 embedding 能力？调用的 API 形状是什么？
 * 这决定"向量检索"能不能落地、成本多少。
 */
import fs from "node:fs";

const B = "D:\\文档\\deepseek-harness\\default-workspace\\dsh-source\\node_modules\\@deepseek-ai";

const pkgs = ["dsh-llm", "dsh-llm-deepseek-api-key", "dsh-llm-deepseek", "dsh-llm-pi-ai", "dsh-llm-retry"];

console.log("=== 在 LLM 相关包里搜 embedding / embed / vector ===");
for (const p of pkgs) {
  const dir = `${B}\\${p}\\lib`;
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const t = fs.readFileSync(`${dir}\\${f}`, "utf8");
    const hits = [];
    for (const re of [/embedding/gi, /\bembed\b/gi, /\bvector\b/gi, /cosine/gi, /rerank/gi]) {
      const n = (t.match(re) ?? []).length;
      if (n) hits.push(`${re.source}×${n}`);
    }
    if (hits.length) console.log(`  ${p}/lib/${f}: ${hits.join(", ")}`);
  }
}
console.log("  (无输出 = 整个 LLM 层没有 embedding 概念)");

console.log("\n=== dsh-llm 暴露的 service / 方法名 ===");
const llmIdx = `${B}\\dsh-llm\\lib\\index.js`;
const t = fs.readFileSync(llmIdx, "utf8");
for (const m of t.matchAll(/super\(ctx,\s*'([^']+)'\)/g)) console.log("  Service 名:", m[1]);
for (const m of t.matchAll(/^\s{1,4}(?:async\s+)?(\w+)\s*\(/gm)) {
  const n = m[1];
  if (/^(stream|complete|generate|request|chat|list|resolve|route)/i.test(n)) console.log("  方法:", n);
}

console.log("\n=== 有没有本地 embedding 依赖（onnx / transformers / sentence）===");
for (const p of fs.readdirSync(B)) {
  if (/onnx|transformers|sentence|embed|vector|faiss|hnsw/i.test(p)) console.log("  " + p);
}
console.log("  (无输出 = 没有)");

console.log("\n=== 本机 Python 侧有没有可用的 embedding 库 ===");
const pyProbe = `
import importlib
for m in ["numpy","sentence_transformers","onnxruntime","sklearn","faiss","torch","openai"]:
    try:
        importlib.import_module(m); print("  OK  ", m)
    except Exception as e:
        print("  --  ", m, "(", type(e).__name__, ")")
`;
fs.writeFileSync("D:\\文档\\deepseek-harness\\default-workspace\\_pyembed.py", pyProbe, "utf8");
