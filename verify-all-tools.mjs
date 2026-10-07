/**
 * 全量端到端实测：5 个工具全部真实调用，验证参数、解析、渲染。
 * 这是修复 lark_doc_search 后的回归测试。
 */
import { pathToFileURL } from "node:url";

const DOC_ID = "XftJda4MVo3qsvxdusIcaUDMn4F";

const registered = new Map();
const fakeCtx = {
  tools: { register: (d) => { registered.set(d.name, d); return () => {}; } },
  logger: { info: () => {}, warn: () => {} },
};

const mod = await import(
  pathToFileURL(
    "D:/文档/deepseek-harness/default-workspace/dsh-plugin-lark-doc/lib/index.js",
  ).href,
);
mod.apply(fakeCtx, { timeoutMs: 180000, identity: "user" });

const exec = { signal: undefined };
let pass = 0;
let fail = 0;

function report(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
  if (detail) console.log(detail.split("\n").map((l) => "      " + l).join("\n"));
}

async function run(name, args) {
  const tool = registered.get(name);
  if (!tool) { report(`${name} 存在`, false); return null; }
  const value = await tool.execute(args, exec);
  const blocks = tool.output.render(args, value);
  const renderOk =
    Array.isArray(blocks) &&
    blocks.length > 0 &&
    blocks.every((b) => b.type === "text" && typeof b.text === "string");
  return { tool, value, renderOk, rendered: blocks.map((b) => b.text).join("\n") };
}

// ---------------------------------------------------------------- search
console.log("=== ① lark_doc_search（修复重点）===");
try {
  const r = await run("lark_doc_search", { query: "能力验证", page_size: 3 });
  report("调用成功", true, r.rendered.slice(0, 700));
  report("items 非空", r.value.items.length > 0, `items=${r.value.items.length}, total=${r.value.total}, has_more=${r.value.has_more}`);
  report("render 形状正确", r.renderOk);
  const noTag = r.value.items.every(
    (it) => !/<h>|<\/h>|<hb>|<\/hb>|<b>|<\/b>/.test(it.title + it.summary),
  );
  report("高亮标签已剥离", noTag, JSON.stringify(r.value.items[0], null, 2));
  const hasUrl = r.value.items.every((it) => typeof it.url === "string" && it.url !== "");
  report("每条都有 url", hasUrl);
  const hasToken = r.value.items.every((it) => typeof it.token === "string" && it.token !== "");
  report("每条都有 token", hasToken);
} catch (e) {
  report("调用成功", false, e.message);
}

console.log("\n=== ② lark_doc_search --mine + --only-title ===");
try {
  const r = await run("lark_doc_search", {
    query: "测试",
    page_size: 5,
    mine: true,
    only_title: true,
  });
  report("调用成功", true, r.rendered.slice(0, 400));
  report("用 --mine 收窄后仍有结果", r.value.items.length > 0, `items=${r.value.items.length}`);
} catch (e) {
  report("调用成功", false, e.message);
}

console.log("\n=== ③ lark_doc_read ===");
try {
  const r = await run("lark_doc_read", { doc: DOC_ID });
  report("调用成功", true, `revision=${r.value.revision_id}, 内容长度=${r.value.content.length}`);
  report("读到内容", r.value.content.length > 0);
  report("render 含内容", r.renderOk);
} catch (e) {
  report("调用成功", false, e.message);
}

console.log("\n=== ④ lark_doc_replace ===");
try {
  const r = await run("lark_doc_replace", {
    doc: DOC_ID,
    pattern: "MARKER-PLUGIN：此段落由 DSH 插件工具写入，验证插件链路通过。",
    content: "MARKER-FINAL：此段落由修复后的插件写入，search/replace 均已验证。",
  });
  report("调用成功", r.value.result === "success", JSON.stringify(r.value));
  report("render 形状正确", r.renderOk);
} catch (e) {
  report("调用成功", false, e.message);
}

console.log("\n=== ⑤ lark_doc_insert ===");
try {
  const r = await run("lark_doc_insert", {
    doc: DOC_ID,
    content: "<h2>插件回归测试</h2><p>5 个工具均已通过端到端实测。</p>",
  });
  report("调用成功", r.value.result === "success", JSON.stringify(r.value));
  report("有 new_blocks", r.value.new_blocks.length > 0);
  report("render 形状正确", r.renderOk);
} catch (e) {
  report("调用成功", false, e.message);
}

console.log("\n=== ⑥ 分页上限校验（page_size 超范围应被飞书拒绝）===");
try {
  await run("lark_doc_search", { query: "测试", page_size: 99 });
  report("超范围被拒绝", false, "竟然成功了");
} catch (e) {
  report("超范围被拒绝", true, e.message.slice(0, 200));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
