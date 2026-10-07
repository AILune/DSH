/**
 * dsh-plugin-lark-doc 的工具定义契约测试 —— 用 dsh-tools 的**真实校验器**。
 *
 * 存在的理由：这个插件写完就从未被挂载过，等于从未被验证过。
 * 而本项目已经栽过一次同类的坑 —— 插件把 `output` 误写成 `returns`，
 * mock 不校验契约所以 113 项测试全绿，真机上 apply() 直接抛 TypeError、
 * 整个插件静默挂不上。
 *
 * 本插件只 import node 内置模块（靠 spawn 调 lark-cli），没有 @deepseek-ai/*
 * 依赖，所以**不需要任何 mock**，可以直接 import 真实实现。
 *
 * 覆盖：
 *  1. apply() 不抛错，5 个工具全部注册成功
 *  2. 每个工具的 output / parameters 都被真实校验器接受（受支持子集）
 *  3. render() 能在合成样本上工作并返回内容块
 *  4. 自证：守门人确实会拒绝 `returns` / 缺 render 的写法
 *
 * 不做的：不真的执行工具（那会 spawn lark-cli 打网络），只做契约层验证。
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const W = "D:\\文档\\deepseek-harness\\default-workspace";
const PLUGIN = path.join(W, "dsh-plugin-lark-doc", "lib", "index.js");
const REAL_TOOLS = path.join(W, "dsh-source", "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js");

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok && detail !== undefined) console.log(`       ${detail}`);
  ok ? (pass += 1) : (fail += 1);
};

if (!fs.existsSync(REAL_TOOLS)) {
  console.error(`❌ 找不到真实 dsh-tools：${REAL_TOOLS}`);
  process.exit(1);
}
const realTools = await import(pathToFileURL(REAL_TOOLS).href);
const mod = await import(pathToFileURL(PLUGIN).href);

/** 逐字复刻 dsh-tools/lib/index.js:2878-2886 的 register() 契约 */
function assertToolDefinition(definition) {
  const name = definition.name;
  const output = definition.output;
  if (
    output === undefined ||
    typeof output !== "object" ||
    typeof output.render !== "function" ||
    (output.presentationMeta !== undefined && typeof output.presentationMeta !== "function")
  ) {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  }
  realTools.assertSupportedJsonSchema(output.schema);
  const timeoutMs = definition.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
  }
  if (name === "run_code") throw new Error(`tool name "run_code" is reserved`);
}

console.log("=== 1. 用真实校验器注册工具（模拟 apply()）===");
const tools = new Map();
const registerErrors = [];
const ctx = {
  logger: { warn: (...a) => console.log("      [warn]", ...a), info: () => {}, error: () => {} },
  tools: {
    register(definition) {
      try {
        assertToolDefinition(definition);
        tools.set(definition.name, definition);
      } catch (e) {
        registerErrors.push(`${definition?.name}: ${e.message}`);
      }
      return () => tools.delete(definition?.name);
    },
  },
};

let applyThrew = null;
let dispose = null;
try {
  dispose = mod.apply(ctx, { timeoutMs: 120000, identity: "user" });
} catch (e) {
  applyThrew = e;
}
check("apply() 未抛错", applyThrew === null, applyThrew && `${applyThrew.constructor.name}: ${applyThrew.message}`);
check("register() 无契约错误", registerErrors.length === 0, registerErrors.join("\n       "));
check("apply() 返回 disposer（卸载可干净注销）", typeof dispose === "function", typeof dispose);

const EXPECTED = ["lark_doc_create", "lark_doc_insert", "lark_doc_read", "lark_doc_replace", "lark_doc_search"];
const got = [...tools.keys()].sort();
check(`恰好注册 ${EXPECTED.length} 个工具`, got.length === EXPECTED.length, `实际 ${got.length}: ${got.join(", ")}`);
check(
  "工具名与预期一致",
  JSON.stringify(got) === JSON.stringify([...EXPECTED].sort()),
  `期望 ${[...EXPECTED].sort().join(", ")}\n       实际 ${got.join(", ")}`,
);

console.log("\n=== 2. 每个工具的定义形状 ===");
for (const [name, def] of tools) {
  check(`${name}: 声明了 output { schema, render }`, typeof def.output?.schema === "object" && typeof def.output.render === "function");
  check(`${name}: 未误用 returns 字段`, def.returns === undefined);
  check(`${name}: 有 description`, typeof def.description === "string" && def.description.length > 0, `${String(def.description).length} 字符`);
}

console.log("\n=== 3. parameters / output.schema 都在受支持子集内 ===");
for (const [name, def] of tools) {
  let okP = true;
  let detailP = "";
  try {
    realTools.assertObjectJsonSchema(def.parameters);
  } catch (e) {
    okP = false;
    detailP = e.message;
  }
  check(`${name}: parameters 合法`, okP, detailP);

  let okO = true;
  let detailO = "";
  try {
    realTools.assertSupportedJsonSchema(def.output.schema);
  } catch (e) {
    okO = false;
    detailO = e.message;
  }
  check(`${name}: output.schema 合法`, okO, detailO);
}

console.log("\n=== 4. render() 在合成样本上可用 ===");
// 按声明的 schema 造最小合法样本：能抓出 render 里的字段名笔误 / 崩溃。
function sampleFor(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const obj = schema.oneOf.find((b) => b?.type === "object");
    return sampleFor(obj ?? schema.oneOf[0]);
  }
  switch (schema.type) {
    case "string":
      return "sample";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [sampleFor(schema.items)];
    case "object": {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = sampleFor(v);
      return out;
    }
    default:
      return null;
  }
}

for (const [name, def] of tools) {
  const sample = sampleFor(def.output.schema);
  const violations = realTools.validateJsonSchemaValue(def.output.schema, sample, "");
  if (violations.length > 0) {
    check(`${name}: 能造出符合 schema 的样本`, false, `样本生成器偏差（不是插件的问题）: ${violations.join("; ")}`);
    continue;
  }
  let rendered;
  let threw = null;
  try {
    rendered = def.output.render({}, sample);
  } catch (e) {
    threw = e;
  }
  check(
    `${name}: render() 可用且返回内容块`,
    threw === null && Array.isArray(rendered) && rendered.length > 0,
    threw ? String(threw) : `返回 ${Array.isArray(rendered) ? rendered.length : typeof rendered} 项`,
  );
}

console.log("\n=== 5. disposer 能注销全部工具 ===");
try {
  dispose();
} catch (e) {
  check("dispose() 未抛错", false, String(e));
}
check("dispose() 后工具全部注销", tools.size === 0, `剩余 ${tools.size}`);

console.log("\n=== 6. 自证：守门人确实能抓到 `returns` 误用 ===");
let caught = null;
try {
  assertToolDefinition({
    name: "fake",
    parameters: { type: "object", properties: {} },
    returns: { type: "object", properties: {} }, // ← 真机上犯过的错误写法
  });
} catch (e) {
  caught = e;
}
check("用 returns 的定义会被拒绝", caught !== null && /must declare output/.test(caught.message), caught === null ? "❌ 未被拒绝 —— 守门人失效！" : caught.message);

let caught2 = null;
try {
  assertToolDefinition({ name: "fake2", output: { schema: { type: "object", properties: {} } } });
} catch (e) {
  caught2 = e;
}
check("缺 output.render 会被拒绝", caught2 !== null && /must declare output/.test(caught2.message), caught2?.message);

let caught3 = null;
try {
  // 经典「可空」写法 —— dsh-tools 明确不支持类型数组
  assertToolDefinition({
    name: "fake3",
    output: { schema: { type: "object", properties: { a: { type: ["string", "null"] } } }, render: () => [] },
  });
} catch (e) {
  caught3 = e;
}
check("类型数组（可空写法）会被拒绝", caught3 !== null && /single type string/.test(caught3.message), caught3?.message);

let caught4 = null;
try {
  assertToolDefinition({
    name: "fake4",
    output: { schema: { type: "object", $ref: "#/definitions/x" }, render: () => [] },
  });
} catch (e) {
  caught4 = e;
}
check("不受支持的关键字（$ref）会被拒绝", caught4 !== null && /not a supported keyword/.test(caught4.message), caught4?.message);

let caught5 = null;
try {
  assertToolDefinition({
    name: "fake5",
    output: { schema: { type: "object", properties: { a: { type: "string" } }, required: ["b"] }, render: () => [] },
  });
} catch (e) {
  caught5 = e;
}
check("required 指向不存在的属性会被拒绝", caught5 !== null && /not in properties/.test(caught5.message), caught5?.message);

console.log("\n=== 7. 记录校验器的受支持子集（供后续参考）===");
// 这一段不判失败，只把真实边界打印出来 —— 之前我对子集的记忆是错的，
// 所以让它可复现，而不是继续靠印象。
for (const [label, schema] of [
  ['type 单值 "null"', { type: "null" }],
  ['annotations（default/description）', { type: "string", default: "x", description: "d" }],
  ['array 无 items', { type: "array" }],
  ['oneOf（2 分支）', { oneOf: [{ type: "string" }, { type: "object", properties: {} }] }],
  ['oneOf（仅 1 分支）', { oneOf: [{ type: "string" }] }],
  ['additionalProperties: false', { type: "object", properties: {}, additionalProperties: false }],
]) {
  let ok = true;
  try {
    realTools.assertSupportedJsonSchema(schema);
  } catch {
    ok = false;
  }
  console.log(`  ${ok ? "接受" : "拒绝"}  ${label}`);
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"} —— 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
