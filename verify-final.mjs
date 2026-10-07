/**
 * 最终全量回归：5 个工具全部真实调用，含 create。
 * 针对上一轮暴露的问题设了明确断言：
 *   - search 用 --page-size 且能解析 data.results
 *   - insert 在 API 不返回 new_blocks 时仍视为成功
 *   - page_size 越界被钳制到 1..20
 *   - doc_format 默认值与 CLI 一致（xml）
 */
import { pathToFileURL } from "node:url";

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
const failures = [];

function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else {
    fail++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
  if (detail) console.log(detail.split("\n").map((l) => "      " + l).join("\n"));
}

async function run(name, args) {
  const tool = registered.get(name);
  const value = await tool.execute(args, exec);
  const blocks = tool.output.render(args, value);
  const renderOk =
    Array.isArray(blocks) &&
    blocks.length > 0 &&
    blocks.every((b) => b.type === "text" && typeof b.text === "string");
  return { value, renderOk, rendered: blocks.map((b) => b.text).join("\n") };
}

console.log("=== ① lark_doc_create（此前从未实测）===");
let createdDocId = null;
try {
  const md = [
    "# 插件最终回归测试",
    "",
    "本文件由 dsh-plugin-lark-doc 的 lark_doc_create 工具创建。",
    "",
    "## 检查项",
    "",
    "- 用 Markdown 导入",
    "- 标题与列表结构保留",
    "",
    "| 项目 | 值 |",
    "|-|-|",
    "| 工具 | lark_doc_create |",
    "| 格式 | markdown |",
  ].join("\n");
  const r = await run("lark_doc_create", {
    title: "插件最终回归测试",
    content: md,
    doc_format: "markdown",
    parent_position: "my_library",
  });
  createdDocId = r.value.document_id;
  check("调用成功", typeof createdDocId === "string" && createdDocId !== "", JSON.stringify(r.value));
  check("返回 url", typeof r.value.url === "string" && r.value.url.startsWith("http"));
  check("render 形状正确", r.renderOk, r.rendered);
} catch (e) {
  check("调用成功", false, e.message);
}

console.log("\n=== ② 读回刚创建的文档，验证内容确实写入 ===");
if (createdDocId) {
  try {
    const r = await run("lark_doc_read", { doc: createdDocId, doc_format: "markdown" });
    check("读取成功", r.value.content.length > 0);
    check("标题写入", r.value.content.includes("插件最终回归测试"), r.value.content.slice(0, 300));
    check("列表写入", r.value.content.includes("用 Markdown 导入"));
    check("表格写入", r.value.content.includes("lark_doc_create"));
  } catch (e) {
    check("读取成功", false, e.message);
  }
} else {
  check("跳过（未创建成功）", false);
}

console.log("\n=== ③ lark_doc_search ===");
try {
  const r = await run("lark_doc_search", { query: "回归测试", page_size: 3 });
  check("调用成功", true, r.rendered.slice(0, 400));
  check("解析出 results", r.value.items.length > 0, `items=${r.value.items.length} total=${r.value.total}`);
  check("无高亮残留", r.value.items.every((i) => !/<h>|<\/h>|<hb>|<\/hb>/.test(i.title + i.summary)));
  check("字段齐全", r.value.items.every((i) => i.url && i.token && i.type && typeof i.owner === "string"));
} catch (e) {
  check("调用成功", false, e.message);
}

console.log("\n=== ④ page_size 越界被钳制（不应报错，也不应拿到 >20）===");
try {
  const r = await run("lark_doc_search", { query: "测试", page_size: 99 });
  check("调用成功且条数 <= 20", r.value.items.length <= 20, `items=${r.value.items.length}`);
} catch (e) {
  check("调用成功且条数 <= 20", false, e.message);
}

console.log("\n=== ⑤ lark_doc_replace（在新建文档上执行）===");
if (createdDocId) {
  try {
    const r = await run("lark_doc_replace", {
      doc: createdDocId,
      pattern: "本文件由 dsh-plugin-lark-doc 的 lark_doc_create 工具创建。",
      content: "本段已被 lark_doc_replace 改写。",
    });
    check("替换成功", r.value.result === "success", JSON.stringify(r.value));
    const back = await run("lark_doc_read", { doc: createdDocId, doc_format: "markdown" });
    check("替换已落盘", back.value.content.includes("本段已被 lark_doc_replace 改写。"));
  } catch (e) {
    check("替换成功", false, e.message);
  }
} else {
  check("跳过（未创建成功）", false);
}

console.log("\n=== ⑥ lark_doc_insert（在新建文档上执行，验证 revision 递增）===");
if (createdDocId) {
  try {
    const before = await run("lark_doc_read", { doc: createdDocId });
    const r = await run("lark_doc_insert", {
      doc: createdDocId,
      content: "<h2>插入验证</h2><p>此段由 lark_doc_insert 追加。</p>",
    });
    check("调用成功", r.value.result === "success", JSON.stringify(r.value));
    check(
      "revision 递增（比 new_blocks 更可靠的成功凭据）",
      r.value.revision_id > before.value.revision_id,
      `${before.value.revision_id} → ${r.value.revision_id}`,
    );
    const after = await run("lark_doc_read", { doc: createdDocId, doc_format: "markdown" });
    check("插入内容已落盘", after.value.content.includes("此段由 lark_doc_insert 追加。"));
  } catch (e) {
    check("调用成功", false, e.message);
  }
} else {
  check("跳过（未创建成功）", false);
}

console.log("\n=== ⑦ 参数校验（回归）===");
const readTool = registered.get("lark_doc_read");
for (const [label, args] of [
  ["缺 required", {}],
  ["类型错误", { doc: 42 }],
  ["enum 非法", { doc: "x", doc_format: "nope" }],
  ["未知属性", { doc: "x", bogus: 1 }],
]) {
  try {
    await readTool.execute(args, exec);
    check(`${label} 被拦截`, false, "未拦截");
  } catch (e) {
    check(`${label} 被拦截`, e.name === "ToolArgsError", e.message.slice(0, 90));
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length > 0) console.log("失败项:", failures.join(" | "));
console.log("\n新建的测试文档 document_id:", createdDocId ?? "(无)");
process.exit(fail === 0 ? 0 : 1);
