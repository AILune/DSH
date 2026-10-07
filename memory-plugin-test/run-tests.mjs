/**
 * 在独立 Node 里加载并测试 dsh-plugin-memory 的真实逻辑。
 *
 * 做法：用 module.register 自定义加载钩子，把插件 import 的 DSH 包
 * 重定向到 mock 模块，从而在不启动 DSH 的情况下执行完整插件代码。
 *
 * 覆盖范围（对齐改造后的实现）：
 *  - 契约：inject 不含 sessionProjections；注册 3 个工具 + systemPrompt 段落
 *    + agent/turn-stopping + session/flush；**不再**注册 agent/pre-step
 *  - 段落渲染：内容、作用域隔离、截断、助手推断标记、实时反映最新状态
 *  - 写入提醒机制：写/删后本会话渲染出「尚未告知」提醒，轮末清空，会话隔离
 *  - flush 计数：由 cwd 重算，injectCount 恒等于 injectedSessions.length
 *
 * 测试桩**故意不提供 sessionProjections**，以此证明插件不再依赖它。
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const MOCKS = "D:\\文档\\deepseek-harness\\default-workspace\\memory-plugin-test\\mocks";

// 先注册加载钩子，再 import 插件
register(pathToFileURL(path.join(MOCKS, "hooks.mjs")), import.meta.url);

// 可用 MEMORY_PLUGIN_PATH 指向别的实现 —— 用于「变异测试」：
// 把实现改回有 bug 的版本，确认本套测试确实会失败（否则就是假绿）。
const PLUGIN = pathToFileURL(
  process.env.MEMORY_PLUGIN_PATH ??
    "D:\\文档\\deepseek-harness\\default-workspace\\dsh-plugin-memory\\lib\\index.js",
).href;

const mod = await import(PLUGIN);

/* ------------------------------------------------------------------ 断言 */

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}`);
  }
  if (detail !== undefined) console.log(`       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/** 反引号在模板字符串里要转义，这里单独取出来做拼接，避免断言字符串被转义搞乱 */
const BT = "`";
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/* --------------------------------------------------------------- 测试环境 */

/** 段落注册顺序表：deployment persona 在最前，模块其余段落排在它之后 */
const ORDERS = { DEPLOYMENT_PERSONA_PREFIX: 0 };
/** 与真实平台一致：context 的 order 是独立命名空间（CONTEXT_ORDERS: 110/115/120） */
const CONTEXT_ORDERS = { SUBAGENT_DELEGATION: 120 };

/**
 * 极简 Cordis 风格 ctx。
 *
 * 注意：**没有** sessionProjections —— 插件的 inject 里已不含它，
 * 这里刻意不提供，任何一个残留依赖都会立刻变成 TypeError。
 */
function makeCtx(sharedFiles, options = {}) {
  const tools = new Map();
  const handlers = new Map(); // event -> [fn]
  const effects = [];
  const sections = new Map(); // name -> section def
  const contexts = new Map(); // name -> runtime context def
  const warns = [];

  // 值域：表存在内存 Map 里，同时把 put/delete 记下来模拟落盘。
  // 传入 sharedFiles 可让第二个实例复用同一份存储，
  // 用于模拟「进程重启后重新打开同一个 domain」（内存里的任何状态都是全新的）。
  const files = sharedFiles ?? new Map();
  const domain = {
    table(tableName) {
      const records = files.get(tableName) ?? new Map();
      files.set(tableName, records);
      return {
        get: (k) => records.get(k),
        entries: () => [...records.entries()][Symbol.iterator](),
        keys: () => [...records.keys()][Symbol.iterator](),
        get size() {
          return records.size;
        },
        async put(k, v) {
          records.set(k, v);
        },
        async delete(k) {
          if (!records.has(k)) return false;
          records.delete(k);
          return true;
        },
        async update(k, fn) {
          if (!records.has(k)) throw new Error(`missing-key ${k}`);
          const next = fn(records.get(k));
          records.set(k, next);
          return next;
        },
      };
    },
    async close() {},
  };

  // deferOpen：让 storageDomain.open 卡在手动的闸门上，
  // 用于构造「apply() 已返回、但域还没打开（table === undefined）」的真实场景。
  let releaseOpen;
  const openGate =
    options.deferOpen === true ? new Promise((resolve) => { releaseOpen = resolve; }) : null;

  const ctx = {
    logger: {
      warn: (...a) => {
        warns.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
        console.log("      [warn]", ...a);
      },
      info: () => {},
      error: (...a) => console.log("      [error]", ...a),
    },
    storageDomain: {
      async open(spec) {
        ctx._openedSpec = spec;
        if (openGate !== null) await openGate;
        return domain;
      },
    },
    systemPrompt: {
      getSectionOrder(name) {
        return ORDERS[name] ?? 0;
      },
      getContextOrder(name) {
        return CONTEXT_ORDERS[name];
      },
      section(def) {
        sections.set(def.name, def);
        return () => sections.delete(def.name);
      },
      context(def) {
        contexts.set(def.name, def);
        return () => contexts.delete(def.name);
      },
    },
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {};
    },
    effect(fn) {
      effects.push(fn);
      return () => {};
    },

    /* 测试辅助 */
    _tools: tools,
    _files: files,
    _handlers: handlers,
    _sections: sections,
    _contexts: contexts,
    /** 用注册进 systemPrompt 的真实 text() 渲染状态标记（那行 runtime context） */
    _renderStatus(session) {
      const def = contexts.get("memory:standing-rules-status");
      if (def === undefined) throw new Error("memory:standing-rules-status 上下文未注册");
      return def.text({ agent: { session } });
    },
    _warns: warns,
    _effects: effects,
    _domain: domain,
    /** 放行被 deferOpen 卡住的 open 闸门 */
    _resolveOpen: (value) => releaseOpen?.(value ?? domain),
    /** 用注册进 systemPrompt 的真实 text() 渲染常驻规则层 */
    _renderSection(session) {
      const def = sections.get("memory:standing-rules");
      if (def === undefined) throw new Error("memory:standing-rules 段落未注册");
      return def.text({ agent: { session } });
    },
    /** 触发 agent/turn-stopping（轮末清空待告知记录） */
    _emitTurnStopping(session) {
      const list = handlers.get("agent/turn-stopping") ?? [];
      for (const fn of list) fn({ agent: { session } });
      return list.length;
    },
  };
  return ctx;
}

const SESSION = { id: "session-test", header: { cwd: "D:\\work\\proj-a" } };
const PROJ_A = "D:\\work\\proj-a";
const PROJ_B = "D:\\work\\proj-b";
/** 从存储里取全部记录（含 key 作为 id） */
const recordsOf = (ctx) => [...ctx._files.get("entries")].map(([id, rec]) => ({ id, ...rec }));
/* --------------------------------------------------------------- 开始测试 */

console.log("=== 1. apply() 能挂载，且契约正确 ===");
check("导出 name = 'memory'", mod.name === "memory", mod.name);
check(
  "inject 恰为 [storageDomain, systemPrompt, tools]",
  JSON.stringify(mod.inject) === JSON.stringify(["storageDomain", "systemPrompt", "tools"]),
  mod.inject,
);
check(
  "inject 不含 sessionProjections（不再依赖投影）",
  !mod.inject.includes("sessionProjections"),
  mod.inject,
);

const ctx = makeCtx();
const dispose = mod.apply(ctx, { maxInject: 24, maxEntryChars: 500, mirror: false });
await tick(30); // 等 ready

check("测试桩不提供 sessionProjections（插件仍能工作）", !("sessionProjections" in ctx));
check("注册了 3 个工具", ctx._tools.size === 3, [...ctx._tools.keys()]);
check(
  "注册的工具恰为 write/recall/delete",
  JSON.stringify([...ctx._tools.keys()].sort()) ===
    JSON.stringify(["memory_delete", "memory_recall", "memory_write"]),
  [...ctx._tools.keys()],
);
check(
  "注册了 systemPrompt 段落 memory:standing-rules",
  ctx._sections.has("memory:standing-rules"),
  [...ctx._sections.keys()],
);
const sectionDef = ctx._sections.get("memory:standing-rules");
check("段落 text 是同步函数", typeof sectionDef?.text === "function" && sectionDef.text.constructor.name !== "AsyncFunction");
check(
  "段落 order 紧随部署人设之后",
  sectionDef?.order === ORDERS.DEPLOYMENT_PERSONA_PREFIX + 1,
  sectionDef?.order,
);
check("注册了 agent/turn-stopping（恰好 1 个）", (ctx._handlers.get("agent/turn-stopping") ?? []).length === 1);
check("**没有**注册 agent/pre-step（已彻底删除）", (ctx._handlers.get("agent/pre-step") ?? []).length === 0);
check("注册了 session/flush（恰好 1 个）", (ctx._handlers.get("session/flush") ?? []).length === 1);
check("返回 disposer", typeof dispose === "function");
check("域名为 memory / per-record", ctx._openedSpec?.name === "memory" && ctx._openedSpec?.layout === "per-record");
check("域版本为 1", ctx._openedSpec?.version === 1);

console.log("\n=== 2. 无记忆时 section 渲染为空串 ===");
const emptyText = ctx._renderSection(SESSION);
check("渲染返回字符串类型", typeof emptyText === "string", typeof emptyText);
check("没有条目、也没有待告知写入时返回 \"\"", emptyText === "", JSON.stringify(emptyText));
check("空渲染里不含常驻规则层标题", !emptyText.includes("## 常驻规则层"));

console.log("\n=== 3. 写入记忆 ===");
const write = ctx._tools.get("memory_write");
const r1 = await write.execute(
  { id: "feishu-status-field", text: "飞书招聘表用「简历评估中」，不要新建选项", scope: "global", tags: ["飞书", "Base"] },
  { agent: { session: SESSION } },
);
check("写入返回 created=true", r1.created === true, r1);
check("总数=1", r1.total === 1);

const r2 = await write.execute(
  { id: "proj-a-convention", text: "本项目用 pnpm 而不是 npm", scope: "workspace", evidence: "user-stated" },
  { agent: { session: SESSION } },
);
check("第二条写入成功", r2.created === true, r2.id);

// 覆盖更新
const r3 = await write.execute(
  { id: "feishu-status-field", text: "飞书招聘表状态字段用「简历评估中」", scope: "global" },
  { agent: { session: SESSION } },
);
check("同名覆盖时 created=false", r3.created === false, r3.id);
check("总数仍为 2", r3.total === 2);

console.log("\n=== 4. 记录形状符合域 schema ===");
const records = [...ctx._files.get("entries").entries()];
check("记录数为 2", records.length === 2);
const [k1, v1] = records.find(([k]) => k.includes("feishu"));
check("全局 key 形如 global_<slug>", /^global_[a-z0-9_-]+$/.test(k1), k1);
check("key 不含冒号（per-record 路径安全约束）", !k1.includes(":"), k1);
check("key 匹配 SAFE_KEY_RE /^[a-zA-Z0-9_-]+$/", /^[a-zA-Z0-9_-]+$/.test(k1), k1);
check("kind = working", v1.kind === "working");
check("scope = global", v1.scope === "global");
check("evidence 默认 user-stated", v1.evidence === "user-stated");
check("injectCount 初始化为 0", v1.injectCount === 0);
check("有 createdAt/updatedAt", typeof v1.createdAt === "number" && typeof v1.updatedAt === "number");
const [, v2] = records.find(([k]) => k.includes("proj-a"));
check("工作区记录带 workspace 路径", v2.workspace === PROJ_A, v2.workspace);
check("工作区记录 scope = workspace", v2.scope === "workspace");

console.log("\n=== 5. section 渲染：内容与安全边界 ===");
// 先清掉 §3 写入留下的待告知提醒，好让本节只考察常驻规则层本身
ctx._emitTurnStopping(SESSION);
const rules = ctx._renderSection(SESSION);
check("渲染返回字符串", typeof rules === "string", typeof rules);
check("含段落标题「## 常驻规则层（用户偏好与稳定约定）」", rules.includes("## 常驻规则层（用户偏好与稳定约定）"));
check("含「无条件生效」声明", rules.includes("**无条件生效**"));
check("说明了与当前要求冲突时的取舍", rules.includes("若与用户当前的要求冲突，以当前要求为准"));
check("指明了不经过检索", rules.includes("不经过检索"));
const globalLine = "- 飞书招聘表状态字段用「简历评估中」";
const wsLine = "- [本工作区] 本项目用 pnpm 而不是 npm";
check("全局条目行形态正确（无作用域前缀、无推断标记）", rules.includes(globalLine), globalLine);
check("工作区条目带「[本工作区] 」前缀", rules.includes(wsLine), wsLine);
check("全局条目的更新时间已被覆盖（旧正文不再出现）", !rules.includes("不要新建选项"));
check(
  "全局条目排在工作区条目之前",
  rules.indexOf(globalLine) !== -1 && rules.indexOf(globalLine) < rules.indexOf(wsLine),
  `global@${rules.indexOf(globalLine)} / ws@${rules.indexOf(wsLine)}`,
);
check("清空提醒后不再出现「本轮记忆写入」段", !rules.includes("## 本轮记忆写入"));
console.log("      ---- 渲染正文 ----");
console.log(rules.split("\n").map((l) => "      " + l).join("\n"));

// 5b. 截断与「助手推断」标记（用更小的 maxEntryChars 单独起一个实例）
console.log("\n--- 5b. 截断 / 助手推断标记 ---");
const ctxTrunc = makeCtx();
mod.apply(ctxTrunc, { maxInject: 24, maxEntryChars: 20, mirror: false });
await tick(30);
const wT = ctxTrunc._tools.get("memory_write");
const longText = "一二三四五六七八九十".repeat(4); // 40 字
await wT.execute({ id: "long-pref", text: longText, scope: "global" }, { agent: { session: SESSION } });
await wT.execute({ id: "guess-pref", text: "用户可能喜欢简短回复", scope: "global", evidence: "inferred" }, { agent: { session: SESSION } });
await wT.execute({ id: "stated-pref", text: "用户明说的偏好", scope: "global" }, { agent: { session: SESSION } });
ctxTrunc._emitTurnStopping(SESSION);
const trunc = ctxTrunc._renderSection(SESSION);
const longLine = trunc.split("\n").find((l) => l.startsWith("- 一二三"));
check("超长正文被截断（不是原样 40 字）", !trunc.includes(longText), "原样出现即为未截断");
check("截断行以省略号结尾", typeof longLine === "string" && longLine.endsWith("…"), longLine);
check(
  "截断到 maxEntryChars=20 个字符（行首 '- ' + 20 + '…'）",
  typeof longLine === "string" && longLine.length === 2 + 20 + 1,
  `实际长度 ${longLine?.length}`,
);
check(
  "evidence=inferred 的条目带「（助手推断，待确认）」",
  trunc.includes("- 用户可能喜欢简短回复（助手推断，待确认）"),
);
check(
  "user-stated 的条目不误加推断标记",
  trunc.split("\n").includes("- 用户明说的偏好"),
  trunc.split("\n").filter((l) => l.startsWith("- 用户明说")).join("|"),
);

// 5c. maxInject 截断（global 优先，因此两条全局必然入选，工作区条目被切掉）
console.log("\n--- 5c. maxInject 生效 ---");
const ctxLimit = makeCtx();
mod.apply(ctxLimit, { maxInject: 2, mirror: false });
await tick(30);
const wL = ctxLimit._tools.get("memory_write");
await wL.execute({ id: "lim-a", text: "全局条目 A", scope: "global" }, { agent: { session: SESSION } });
await wL.execute({ id: "lim-b", text: "全局条目 B", scope: "global" }, { agent: { session: SESSION } });
await wL.execute({ id: "lim-c", text: "工作区条目 C", scope: "workspace" }, { agent: { session: SESSION } });
ctxLimit._emitTurnStopping(SESSION);
const limited = ctxLimit._renderSection(SESSION);
const bulletLines = limited.split("\n").filter((l) => l.startsWith("- "));
check("maxInject=2 时只渲染 2 条", bulletLines.length === 2, bulletLines);
check("渲染的 2 条都是全局条目", limited.includes("全局条目 A") && limited.includes("全局条目 B"), bulletLines);
check("被 maxInject 切掉的工作区条目不出现", !limited.includes("工作区条目 C"));

console.log("\n=== 6. section 每次渲染都反映最新状态（不再有「补注入/待尾」语义）===");
const ctxLive = makeCtx();
mod.apply(ctxLive, { maxInject: 24, mirror: false });
await tick(30);
const wLive = ctxLive._tools.get("memory_write");
const delLive = ctxLive._tools.get("memory_delete");
await wLive.execute({ id: "live-pref", text: "第一版：用 pnpm", scope: "global" }, { agent: { session: SESSION } });
ctxLive._emitTurnStopping(SESSION);
const live1 = ctxLive._renderSection(SESSION);
check("首版内容立刻出现在渲染里", live1.includes("第一版：用 pnpm"), live1.slice(0, 160));

await wLive.execute({ id: "live-pref", text: "第二版：改用 yarn", scope: "global" }, { agent: { session: SESSION } });
ctxLive._emitTurnStopping(SESSION);
const live2 = ctxLive._renderSection(SESSION);
check("改一条偏好后再次渲染立刻变（新正文出现）", live2.includes("第二版：改用 yarn"));
check("旧正文不再出现（不是缓存）", !live2.includes("第一版：用 pnpm"));
check("没有重复渲染同一 id（仍只有一行）", countOf(live2, "- 第二版：改用 yarn") === 1, countOf(live2, "- 第二版：改用 yarn"));

await wLive.execute({ id: "live-extra", text: "额外条目", scope: "global" }, { agent: { session: SESSION } });
ctxLive._emitTurnStopping(SESSION);
check("新增条目立刻可见", ctxLive._renderSection(SESSION).includes("额外条目"));

await delLive.execute({ id: "live-pref" }, { agent: { session: SESSION } });
ctxLive._emitTurnStopping(SESSION);
const live3 = ctxLive._renderSection(SESSION);
check("删除一条后渲染里不再有它", !live3.includes("第二版：改用 yarn"), live3.slice(0, 160));

await delLive.execute({ id: "live-extra" }, { agent: { session: SESSION } });
ctxLive._emitTurnStopping(SESSION);
const live4 = ctxLive._renderSection(SESSION);
check("删光后渲染回到空串", live4 === "", JSON.stringify(live4));

console.log("\n=== 7. 工作区隔离 ===");
const ctxB = makeCtx();
mod.apply(ctxB, { maxInject: 24, mirror: false });
await tick(30);
const wB = ctxB._tools.get("memory_write");
await wB.execute({ id: "global-only", text: "全局偏好 A", scope: "global" }, { agent: { session: { header: { cwd: PROJ_B } } } });
await wB.execute({ id: "b-only", text: "B 工作区专属", scope: "workspace" }, { agent: { session: { header: { cwd: PROJ_B } } } });
// 故意在 ctxB 里也放一条 proj-a 的专属记忆，让「看不到」这句断言不是空话
await wB.execute({ id: "a-only", text: "A 工作区专属", scope: "workspace" }, { agent: { session: { header: { cwd: PROJ_A } } } });

const sessB = { id: "s-b", header: { cwd: PROJ_B } };
ctxB._emitTurnStopping(sessB);
const bodyB = ctxB._renderSection(sessB);
check("proj-b 看到自己的专属记忆", bodyB.includes("B 工作区专属"));
check("proj-b 看不到 proj-a 的专属记忆", !bodyB.includes("A 工作区专属"), "（proj-a 的记忆不应出现）");
check("proj-b 能看到全局记忆", bodyB.includes("全局偏好 A"));

const sessA = { id: "s-a", header: { cwd: PROJ_A } };
ctxB._emitTurnStopping(sessA);
const bodyA = ctxB._renderSection(sessA);
check("反过来 proj-a 看到自己的专属记忆", bodyA.includes("A 工作区专属"));
check("反过来 proj-a 看不到 proj-b 的专属记忆", !bodyA.includes("B 工作区专属"));
check("proj-a 同样能看到全局记忆", bodyA.includes("全局偏好 A"));

console.log("\n=== 8. memory_recall 过滤 ===");
const recall = ctxB._tools.get("memory_recall");
const all = await recall.execute({}, { agent: { session: sessB } });
check("recall 无参返回本工作区可见条目", all.total === 2, all.total);
const filtered = await recall.execute({ query: "全局" }, { agent: { session: sessB } });
check("关键词过滤生效", filtered.total === 1, filtered.total);
const scoped = await recall.execute({ scope: "workspace" }, { agent: { session: sessB } });
check("scope 过滤生效", scoped.total === 1, scoped.total);

console.log("\n=== 9. memory_delete ===");
const delB = ctxB._tools.get("memory_delete");
const d1 = await delB.execute({ id: "b-only" });
check("用短标识删除成功", d1.deleted === true, d1);
check("返回被解析出的完整 key", /(^|_)(b-only)$/.test(String(d1.id)), d1.id);
const d2 = await delB.execute({ id: "不存在的" });
check("删除不存在的返回 false（不抛错）", d2.deleted === false, d2);
const afterDel = await recall.execute({}, { agent: { session: sessB } });
check("删除后 recall 只剩 1 条", afterDel.total === 1, afterDel.total);

console.log("\n=== 10. session/flush 更新注入计数（每会话只计一次） ===");
const flushList = ctx._handlers.get("session/flush") ?? [];
check("flush 处理器存在", flushList.length === 1);
if (flushList.length) {
  // 同一会话连续 flush 多次（真实情况：一轮里会触发多次）
  await flushList[0](SESSION);
  await flushList[0](SESSION);
  await flushList[0](SESSION);

  const after = recordsOf(ctx);
  const injectedOnes = after.filter((r) => r.injectCount > 0);
  check("被注入过的记忆 injectCount 增加", injectedOnes.length === 2, injectedOnes.map((r) => r.injectCount));
  check("同一会话重复 flush 只计一次（不是 3）", injectedOnes.every((r) => r.injectCount === 1), injectedOnes.map((r) => r.injectCount));
  check("记录了 lastInjectedAt", injectedOnes.every((r) => typeof r.lastInjectedAt === "number"));

  // 另一个会话（同 cwd）应各自计一次
  const otherSession = { id: "session-other", header: { cwd: PROJ_A } };
  await flushList[0](otherSession);
  const after2 = recordsOf(ctx).filter((r) => r.injectCount > 0);
  check("不同会话各计一次（累加到 2）", after2.every((r) => r.injectCount === 2), after2.map((r) => r.injectCount));
  check(
    "injectCount 恒等于 injectedSessions.length",
    after2.every((r) => r.injectCount === (r.injectedSessions ?? []).length),
    after2.map((r) => [r.injectCount, r.injectedSessions?.length]),
  );

  // 无关会话（别的 cwd，看不见任何本工作区条目）不应被计数
  const foreign = { id: "session-foreign", header: { cwd: "D:\\work\\proj-elsewhere" } };
  await flushList[0](foreign);
  const after3 = recordsOf(ctx).filter((r) => r.injectCount > 0);
  check(
    "别的 cwd 的会话不会误计（只计入它真能看到的全局条目）",
    after3.every((r) => !(r.injectedSessions ?? []).includes(foreign.id) || r.scope === "global"),
    after3.map((r) => [r.id, r.scope, r.injectCount]),
  );
}

console.log("\n=== 11. 记录校验器拒绝坏数据 ===");
const spec = ctx._openedSpec;
const tableSchema = spec.tables.entries.valueSchema;
let threw = 0;
for (const bad of [
  null,
  { text: "", kind: "working", scope: "global", evidence: "user-stated", createdAt: 1, updatedAt: 1 },
  { text: "x", kind: "bogus", scope: "global", evidence: "user-stated", createdAt: 1, updatedAt: 1 },
  { text: "x", kind: "working", scope: "bogus", evidence: "user-stated", createdAt: 1, updatedAt: 1 },
  { text: "x", kind: "working", scope: "global", evidence: "bogus", createdAt: 1, updatedAt: 1 },
  { text: "x", kind: "working", scope: "global", evidence: "user-stated", createdAt: 1 },
]) {
  try {
    tableSchema.parse(bad);
  } catch {
    threw++;
  }
}
check("6 条坏数据全部被拒绝", threw === 6, `${threw}/6`);
const good = tableSchema.parse({
  text: "ok", kind: "working", scope: "global", evidence: "user-stated", createdAt: 1, updatedAt: 1, tags: undefined, injectCount: undefined,
});
check("好数据被规范化（tags 补空数组）", Array.isArray(good.tags) && good.tags.length === 0, good);
check("好数据 injectCount 补 0", good.injectCount === 0, good.injectCount);

console.log("\n=== 12. 回归：进程重启 / 插件热加载后不得重复计数 ===");
// 复现 2026-10-04 实测到的 bug：旧实现用「内存里的 Set」去重，
// 进程重启或插件热加载都会清零，于是同一个会话被反复计数。
// 实测计数涨到 8，而按会话日志最多只可能有 4 个会话被注入过。
{
  const beforeCounts = recordsOf(ctx)
    .filter((r) => r.injectCount > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => r.injectCount);

  // 全新插件实例 + 同一份存储 = 重启后重新打开同一个 domain（内存去重必然为空）
  const ctxRestart = makeCtx(ctx._files);
  mod.apply(ctxRestart, { maxInject: 24, maxEntryChars: 500, mirror: false });
  await tick(30);

  const restartFlush = ctxRestart._handlers.get("session/flush") ?? [];
  check("重启后的实例注册了 flush 处理器", restartFlush.length === 1);
  // 不再需要投影喂数据：flush 直接由 session.header.cwd 重算
  await restartFlush[0](SESSION);

  const after = recordsOf(ctxRestart)
    .filter((r) => r.injectCount > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const afterCounts = after.map((r) => r.injectCount);
  check(
    "重启后同一会话不再重复计数",
    JSON.stringify(afterCounts) === JSON.stringify(beforeCounts),
    `${beforeCounts} -> ${afterCounts}`,
  );
  check(
    "injectCount 等于 injectedSessions.length（计数可核验）",
    after.every((r) => r.injectCount === (r.injectedSessions ?? []).length),
    after.map((r) => [r.injectCount, r.injectedSessions?.length]),
  );
  check(
    "记录里存了具体会话 id（不再只是数字）",
    after.every((r) => Array.isArray(r.injectedSessions) && r.injectedSessions.includes(SESSION.id)),
    after.map((r) => r.injectedSessions),
  );
  check("即使不计数，lastInjectedAt 仍被刷新", after.every((r) => typeof r.lastInjectedAt === "number"));
  check(
    "重启后的实例也不再注册 agent/pre-step",
    (ctxRestart._handlers.get("agent/pre-step") ?? []).length === 0,
  );
}

/* ============================ 13~20 写入提醒机制 ============================ */

console.log("\n=== 13. 写入后本会话渲染出「尚未告知」提醒 ===");
const ctxNotice = makeCtx();
mod.apply(ctxNotice, { mirror: false });
await tick(30);
const wN = ctxNotice._tools.get("memory_write");
await wN.execute({ id: "notice-basic", text: "写入提醒测试条目", scope: "global" }, { agent: { session: SESSION } });
const noticeText = ctxNotice._renderSection(SESSION);
check("含提醒段标题「## 本轮记忆写入（尚未告知用户）」", noticeText.includes("## 本轮记忆写入（尚未告知用户）"));
check(
  "含该条 id 的写入行",
  noticeText.includes("- 已写入/更新 " + BT + "global_notice-basic" + BT),
  noticeText.slice(0, 400),
);
check(
  "含「最后一行」强制要求那句",
  noticeText.includes("**你必须在本次回复的最后一行，用一句话明确告知用户这次改动及其 id。**"),
);
check("含硬性约定的说明", noticeText.includes("这是硬性约定"));
check("常驻规则层本身也在同一份渲染里", noticeText.includes("## 常驻规则层（用户偏好与稳定约定）"));
check("提醒段排在常驻规则层之后（模型写回复前最后读到）", noticeText.indexOf("## 本轮记忆写入") > noticeText.indexOf("## 常驻规则层"));
console.log("      ---- 渲染正文 ----");
console.log(noticeText.split("\n").map((l) => "      " + l).join("\n"));

console.log("\n=== 14. created / updated 用词与记录 ===");
const ctxDup = makeCtx();
mod.apply(ctxDup, { mirror: false });
await tick(30);
const wD = ctxDup._tools.get("memory_write");
const first = await wD.execute({ id: "dup-pref", text: "首版正文", scope: "global" }, { agent: { session: SESSION } });
check("首次写入返回 created=true", first.created === true, first);
const afterCreate = ctxDup._renderSection(SESSION);
check(
  "首次写入渲染出「已写入/更新」行",
  afterCreate.includes("- 已写入/更新 " + BT + "global_dup-pref" + BT),
  afterCreate.split("\n").filter((l) => l.startsWith("- ")).join(" | "),
);
check("此时只有一笔待告知记录", countOf(afterCreate, "- 已写入/更新 ") === 1, countOf(afterCreate, "- 已写入/更新 "));

const second = await wD.execute({ id: "dup-pref", text: "覆盖后的正文", scope: "global" }, { agent: { session: SESSION } });
check("覆盖同 id 返回 created=false", second.created === false, second.id);
const afterUpdate = ctxDup._renderSection(SESSION);
check(
  "覆盖后渲染出的仍是「已写入/更新」行（与创建同一句）",
  afterUpdate.includes("- 已写入/更新 " + BT + "global_dup-pref" + BT),
);
check(
  "同一 id 在同一轮里被写两次，待告知只保留一笔（去重，不产生重复行）",
  countOf(afterUpdate, "- 已写入/更新 ") === 1,
  countOf(afterUpdate, "- 已写入/更新 "),
);
check(
  "去重保留的是最后一次结果，id 仍正确",
  afterUpdate.includes("- 已写入/更新 " + BT + "global_dup-pref" + BT),
  afterUpdate.split("\n").filter((l) => l.startsWith("- ")).join(" | "),
);

ctxDup._emitTurnStopping(SESSION);
check("轮末清空后提醒段消失", !ctxDup._renderSection(SESSION).includes("本轮记忆写入"));
const third = await wD.execute({ id: "dup-pref", text: "第三版正文", scope: "global" }, { agent: { session: SESSION } });
check("清空后再覆盖仍是 created=false", third.created === false);
check(
  "清空后只累积本次的新提醒（1 笔）",
  countOf(ctxDup._renderSection(SESSION), "- 已写入/更新 ") === 1,
  countOf(ctxDup._renderSection(SESSION), "- 已写入/更新 "),
);

console.log("\n=== 15. 删除也会提醒 ===");
const ctxDel = makeCtx();
mod.apply(ctxDel, { mirror: false });
await tick(30);
const wDel = ctxDel._tools.get("memory_write");
const delTool = ctxDel._tools.get("memory_delete");
await wDel.execute({ id: "del-pref", text: "待删除条目", scope: "global" }, { agent: { session: SESSION } });
ctxDel._emitTurnStopping(SESSION); // 清掉写入提醒，确保后面看到的是删除提醒
check("（前置）清空后无提醒段", !ctxDel._renderSection(SESSION).includes("本轮记忆写入"));

const delRes = await delTool.execute({ id: "del-pref" }, { agent: { session: SESSION } });
check("删除成功", delRes.deleted === true, delRes);
const delText = ctxDel._renderSection(SESSION);
check("删除后重新渲染出提醒段", delText.includes("## 本轮记忆写入（尚未告知用户）"));
check(
  "含「已删除 `id`」行",
  delText.includes("- 已删除 " + BT + "global_del-pref" + BT),
  delText.split("\n").filter((l) => l.startsWith("- ")).join(" | "),
);
check("不把删除谎报成写入", !delText.includes("- 已写入/更新 "));
check("删除后条目已不在常驻规则层", !delText.includes("- 待删除条目"));

// 删除不存在的东西不应产生提醒
ctxDel._emitTurnStopping(SESSION);
const delMiss = await delTool.execute({ id: "no-such-entry" }, { agent: { session: SESSION } });
check("删除不存在的条目返回 false", delMiss.deleted === false, delMiss);
check("删除不存在的条目不产生提醒（不谎报）", !ctxDel._renderSection(SESSION).includes("本轮记忆写入"));

console.log("\n=== 16. turn-stopping 清空待告知记录 ===");
const ctxTurn = makeCtx();
mod.apply(ctxTurn, { mirror: false });
await tick(30);
const wT2 = ctxTurn._tools.get("memory_write");
await wT2.execute({ id: "turn-pref", text: "轮末清空测试", scope: "global" }, { agent: { session: SESSION } });
check("（前置）写入后渲染有提醒段", ctxTurn._renderSection(SESSION).includes("## 本轮记忆写入（尚未告知用户）"));

const emitted = ctxTurn._emitTurnStopping(SESSION);
check("turn-stopping 处理器被调用（1 个）", emitted === 1, emitted);
const afterTurn = ctxTurn._renderSection(SESSION);
check("turn-stopping 后不再有提醒段", !afterTurn.includes("## 本轮记忆写入"));
check("清空的只是提醒，条目本身还在", afterTurn.includes("- 轮末清空测试"));

console.log("\n=== 17. 会话隔离：不能在没有写入的会话里谎报写入 ===");
const ctxIso = makeCtx();
mod.apply(ctxIso, { mirror: false });
await tick(30);
const wIso = ctxIso._tools.get("memory_write");
const sessIsoA = { id: "s-iso-a", header: { cwd: PROJ_A } };
const sessIsoB = { id: "s-iso-b", header: { cwd: PROJ_A } }; // 同一个工作区、不同会话
await wIso.execute({ id: "iso-pref", text: "仅 A 会话写入", scope: "global" }, { agent: { session: sessIsoA } });

const textA = ctxIso._renderSection(sessIsoA);
const textB = ctxIso._renderSection(sessIsoB);
check("写入的会话 A 看到提醒段", textA.includes("## 本轮记忆写入（尚未告知用户）"));
check("会话 B 看不到提醒段", !textB.includes("## 本轮记忆写入"), textB.slice(0, 200));
check("会话 B 仍能看到条目本体（说明不是整体渲染失败）", textB.includes("- 仅 A 会话写入"));
check("会话 A 的提醒里带 id", textA.includes(BT + "global_iso-pref" + BT));

// A 轮末清空后，B 依然不受影响
ctxIso._emitTurnStopping(sessIsoA);
check("A 清空后 A 无提醒", !ctxIso._renderSection(sessIsoA).includes("本轮记忆写入"));
check("A 清空不影响 B（B 本来就没有）", !ctxIso._renderSection(sessIsoB).includes("本轮记忆写入"));

console.log("\n=== 18. 没写入就不提醒 ===");
const ctxNone = makeCtx();
mod.apply(ctxNone, { mirror: false });
await tick(30);
const fresh = ctxNone._renderSection(sessIsoB);
check("全新实例未写入时渲染为空串", fresh === "", JSON.stringify(fresh));
check("全新实例的渲染里没有提醒段", !fresh.includes("本轮记忆写入"));

const wNone = ctxNone._tools.get("memory_write");
const sessWriter = { id: "s-writer", header: { cwd: PROJ_A } };
await wNone.execute({ id: "none-pref", text: "由别的会话写入", scope: "global" }, { agent: { session: sessWriter } });
ctxNone._emitTurnStopping(sessWriter); // 写入者自己也不留提醒
const readerText = ctxNone._renderSection(sessIsoB);
check("有条目、但本会话没写过 → 有条目而无提醒段", readerText.includes("- 由别的会话写入") && !readerText.includes("本轮记忆写入"), readerText.slice(0, 200));

console.log("\n=== 19. 未就绪 / 内部抛错：返回空串且不炸 ===");
// 19a. apply() 已返回、open 还没完成（table === undefined）——真实可复现：
// 用闸门把 storageDomain.open 卡住，apply() 返回后同步渲染。
const ctxLate = makeCtx(undefined, { deferOpen: true });
mod.apply(ctxLate, { mirror: false });
let earlyValue;
let earlyError;
try {
  earlyValue = ctxLate._renderSection(SESSION);
} catch (e) {
  earlyError = e;
}
check("域未打开时渲染不抛异常", earlyError === undefined, earlyError?.message);
check("域未打开时渲染返回空串", earlyValue === "", JSON.stringify(earlyValue));

ctxLate._resolveOpen();
await tick(30);
const wLate = ctxLate._tools.get("memory_write");
await wLate.execute({ id: "late-ready", text: "就绪后的条目", scope: "global" }, { agent: { session: SESSION } });
ctxLate._emitTurnStopping(SESSION);
const lateText = ctxLate._renderSection(SESSION);
check(
  "放行 open 后同一段落立刻渲染出条目（证明刚才的空串确因未就绪）",
  lateText.includes("- 就绪后的条目"),
  lateText.slice(0, 200),
);

// 19b. text 内部抛错被吞掉，只 warn，不向外抛
const warnsBefore = ctx._warns.length;
const badContext = {
  agent: {
    get session() {
      throw new Error("boom: session getter");
    },
  },
};
let thrown;
let swallowed;
try {
  swallowed = ctx._sections.get("memory:standing-rules").text(badContext);
} catch (e) {
  thrown = e;
}
check("text 内部异常不外抛", thrown === undefined, thrown?.message);
check("text 内部异常时返回空串", swallowed === "", JSON.stringify(swallowed));
check(
  "异常被记为 logger.warn（含「渲染常驻规则层失败」）",
  ctx._warns.length === warnsBefore + 1 && ctx._warns[ctx._warns.length - 1].includes("渲染常驻规则层失败"),
  ctx._warns.slice(warnsBefore),
);
check("出过错之后段落仍能正常渲染", ctx._renderSection(SESSION).includes("## 常驻规则层"), "（异常未污染状态）");

console.log("\n=== 20. flush 记下的 ids 与 section 渲染的条目口径一致 ===");
const ctxIds = makeCtx();
mod.apply(ctxIds, { maxInject: 3, mirror: false }); // maxInject=3 让「切片」这条路径也走一遍
await tick(30);
const wIds = ctxIds._tools.get("memory_write");
const PROJ_IDS = "D:\\work\\proj-ids";
const PROJ_OTHER = "D:\\work\\proj-other";
const sessIds = { id: "s-ids", header: { cwd: PROJ_IDS } };
const sessOther = { id: "s-other", header: { cwd: PROJ_OTHER } };
await wIds.execute({ id: "ids-global-a", text: "MARK-A 全局偏好", scope: "global" }, { agent: { session: sessIds } });
await wIds.execute({ id: "ids-global-b", text: "MARK-B 全局偏好", scope: "global" }, { agent: { session: sessIds } });
await wIds.execute({ id: "ids-ws-c", text: "MARK-C 本工作区偏好", scope: "workspace" }, { agent: { session: sessIds } });
await wIds.execute({ id: "ids-ws-e", text: "MARK-E 本工作区偏好二", scope: "workspace" }, { agent: { session: sessIds } });
await wIds.execute({ id: "ids-other-d", text: "MARK-D 别的项目偏好", scope: "workspace" }, { agent: { session: sessOther } });

/** 渲染文本里出现了哪些条目（正文当指纹，避免依赖渲染不含 id 的事实） */
const renderedIds = (text) => recordsOf(ctxIds).filter((r) => text.includes(r.text)).map((r) => r.id).sort();
const flushedIds = (sessionId) =>
  recordsOf(ctxIds)
    .filter((r) => (r.injectedSessions ?? []).includes(sessionId))
    .map((r) => r.id)
    .sort();

const idsFlush = ctxIds._handlers.get("session/flush") ?? [];
check("flush 处理器存在（新实例）", idsFlush.length === 1);

// 20a. 会话 s-ids：全局 A/B 必然入选，工作区 C/E 只有一个能进 slice(0,3)
// 先清掉写入提醒，好让「渲染几条」只数条目行（提醒行也以 "- " 开头）
ctxIds._emitTurnStopping(sessIds);
const idsText = ctxIds._renderSection(sessIds);
check("渲染里含全局 A/B", idsText.includes("MARK-A") && idsText.includes("MARK-B"));
check("maxInject=3 时渲染 3 条", idsText.split("\n").filter((l) => l.startsWith("- ")).length === 3, idsText.split("\n").filter((l) => l.startsWith("- ")));
check("别的项目的条目 D 不出现在 s-ids 的渲染里", !idsText.includes("MARK-D"));
const sectionSet = renderedIds(idsText);
await idsFlush[0](sessIds);
const flushedSet = flushedIds(sessIds.id);
check("渲染 3 条（含切片后的工作区条目）", sectionSet.length === 3, sectionSet);
check(
  "flush 记入的 id 集合 === section 渲染的 id 集合",
  JSON.stringify(sectionSet) === JSON.stringify(flushedSet),
  `${JSON.stringify(sectionSet)} vs ${JSON.stringify(flushedSet)}`,
);
check("别的项目条目 D 没有被记入", !flushedSet.some((id) => id.includes("ids-other-d")), flushedSet);

// 20b. 换个会话（别的 cwd）：口径同样一致，且看到的是它自己的那组
ctxIds._emitTurnStopping(sessOther);
const otherText = ctxIds._renderSection(sessOther);
const otherSectionSet = renderedIds(otherText);
check("s-other 渲染里是 A/B/D", otherSectionSet.length === 3, otherSectionSet);
await idsFlush[0](sessOther);
const otherFlushedSet = flushedIds(sessOther.id);
check(
  "换会话后两处口径仍一致",
  JSON.stringify(otherSectionSet) === JSON.stringify(otherFlushedSet),
  `${JSON.stringify(otherSectionSet)} vs ${JSON.stringify(otherFlushedSet)}`,
);

const allIdsRecords = recordsOf(ctxIds);
check(
  "所有记录 injectCount === injectedSessions.length",
  allIdsRecords.every((r) => (r.injectCount ?? 0) === (r.injectedSessions ?? []).length),
  allIdsRecords.map((r) => [r.id, r.injectCount ?? 0, r.injectedSessions?.length ?? 0]),
);
check(
  "条目 D 只被真正看到它的那个会话记入（s-other），不被 s-ids 记入",
  allIdsRecords
    .filter((r) => r.id.includes("ids-other-d"))
    .every(
      (r) =>
        JSON.stringify(r.injectedSessions) === JSON.stringify([sessOther.id]) &&
        !(r.injectedSessions ?? []).includes(sessIds.id),
    ),
  allIdsRecords.filter((r) => r.id.includes("ids-other-d")).map((r) => [r.injectCount, r.injectedSessions]),
);

console.log("\n=== 21. 回归：会话数超过 128 上限后 injectCount 仍 === injectedSessions.length ===");
// 这一节的由来：旧实现用 injectCount+1 累加，而 injectedSessions 有 128 上限。
// 超出上限后旧 id 会被裁掉，被裁掉的会话再现时被重复计数，计数还会与列表脱钩
// ——实测 130 个会话得到 injectCount=130 而列表只有 128。
// 现在 injectCount 一律由列表长度推导，所以「照着记录文件数一遍就能核验」恒成立。
const ctxCap = makeCtx();
mod.apply(ctxCap, { mirror: false });
await tick(30);
const wCap = ctxCap._tools.get("memory_write");
const CAP_CWD = "D:\\work\\proj-cap";
await wCap.execute(
  { id: "cap-pref", text: "CAP 回归条目", scope: "global" },
  { agent: { session: { id: "cap-seed", header: { cwd: CAP_CWD } } } },
);
const capFlush = ctxCap._handlers.get("session/flush") ?? [];
check("flush 处理器存在（新实例）", capFlush.length === 1);
const capSess = (i) => ({ id: `cap-${String(i).padStart(3, "0")}`, header: { cwd: CAP_CWD } });
for (let i = 0; i < 130; i += 1) await capFlush[0](capSess(i));

const capRec = recordsOf(ctxCap).find((r) => r.id === "global_cap-pref");
const capList = capRec?.injectedSessions ?? [];
check("130 个会话后列表被裁剪到上限 128", capList.length === 128, capList.length);
check("injectCount === injectedSessions.length（不再脱钩）", capRec.injectCount === capList.length, [capRec.injectCount, capList.length]);
check("injectCount 没有虚增到 130", capRec.injectCount === 128, capRec.injectCount);
check(
  "保留的是最近 128 个会话（最早的被裁掉）",
  capList.includes("cap-129") && !capList.includes("cap-000"),
  [capList[0], capList[capList.length - 1]],
);

// 关键一步：让已被裁掉的会话再来一次。旧实现会在这里把计数加到 129。
await capFlush[0](capSess(0));
const capRec2 = recordsOf(ctxCap).find((r) => r.id === "global_cap-pref");
check(
  "被裁掉的会话再现时计数不虚增（旧实现的破法）",
  capRec2.injectCount === 128 && capRec2.injectCount === (capRec2.injectedSessions ?? []).length,
  [capRec2.injectCount, capRec2.injectedSessions?.length],
);

console.log("\n=== 22. 常驻规则层开场算一次：无写入时复用缓存，写入后才重算 ===");
const ctxCache = makeCtx();
mod.apply(ctxCache, { mirror: false });
await tick(30);
const wCache = ctxCache._tools.get("memory_write");
const CACHE_CWD = "D:\\work\\proj-cache";
const CACHE_OTHER = "D:\\work\\proj-cache-other";
const sessCache = { id: "s-cache", header: { cwd: CACHE_CWD } };
const sessCacheOther = { id: "s-cache-other", header: { cwd: CACHE_OTHER } };
await wCache.execute({ id: "cache-a", text: "缓存基线 A", scope: "global" }, { agent: { session: sessCache } });
await wCache.execute(
  { id: "cache-other", text: "另一个工作区的条目", scope: "workspace" },
  { agent: { session: sessCacheOther } },
);
ctxCache._emitTurnStopping(sessCache);
ctxCache._emitTurnStopping(sessCacheOther);

const c22Base = ctxCache._renderSection(sessCache);
check("首次渲染含基线 A", c22Base.includes("缓存基线 A"), c22Base.slice(0, 120));
check("首次渲染不含别的工作区的条目", !c22Base.includes("另一个工作区的条目"));

const c22Other = ctxCache._renderSection(sessCacheOther);
check("另一个工作区渲染出自己的条目", c22Other.includes("另一个工作区的条目"), c22Other.slice(0, 160));
const c22Back = ctxCache._renderSection(sessCache);
check(
  "切回原工作区仍拿到原文本（缓存按 cwd 分槽，没有串味）",
  c22Back === c22Base,
  c22Back.slice(0, 120),
);

// 关键一步：绕过插件直接改底层存储。
// 如果插件是每步重算，这个改动必然出现在下一次渲染里。
const rawRecords = ctxCache._files.get("entries");
const keyA = [...rawRecords.keys()].find((k) => k.endsWith("cache-a"));
check("能定位到底层记录（否则本节后续断言无意义）", typeof keyA === "string", keyA);
rawRecords.get(keyA).text = "绕过插件直接改的正文";
const c22Hit = ctxCache._renderSection(sessCache);
check(
  "无写入时复用缓存：绕过插件的底层改动不被反映（证明没有每步重算）",
  c22Hit === c22Base && !c22Hit.includes("绕过插件直接改的正文"),
  c22Hit.includes("绕过插件直接改的正文") ? "（说明每步都在重算）" : "缓存命中，未重算",
);

// 真正的写入必须让下一次渲染立刻重算，并读到最新状态
await wCache.execute({ id: "cache-b", text: "新增基线 B", scope: "global" }, { agent: { session: sessCache } });
const c22Written = ctxCache._renderSection(sessCache);
check("写入后立刻重算：新条目可见", c22Written.includes("新增基线 B"), c22Written.slice(0, 200));
check(
  "重算读到的是最新底层状态（绕过改动一并出现，证明整块重算）",
  c22Written.includes("绕过插件直接改的正文"),
  c22Written.slice(0, 200),
);

// flush 只改 injectCount / lastInjectedAt，而渲染只读 text/scope/evidence/updatedAt，
// 所以它不该推进版本号 —— 否则每轮 flush 都白送一次前缀缓存失效。
ctxCache._emitTurnStopping(sessCache);
const c22PreFlush = ctxCache._renderSection(sessCache);
const cacheFlush = ctxCache._handlers.get("session/flush") ?? [];
check("flush 处理器存在（新实例）", cacheFlush.length === 1);
await cacheFlush[0](sessCache);
const c22RecA = [...rawRecords.entries()].find(([k]) => k.endsWith("cache-a"))?.[1];
check("flush 确实改到了记录（否则下面那条回归没意义）", (c22RecA?.injectCount ?? 0) > 0, c22RecA?.injectCount);
const c22PostFlush = ctxCache._renderSection(sessCache);
check("flush（只改计数）不会改变常驻规则层文本", c22PostFlush === c22PreFlush, c22PostFlush.slice(0, 140));

/* =========================================================================
 * §23 状态标记（runtime context）—— 让「插件在不在、有没有重新加载」每轮可见
 *
 * 为什么必须有：偏好块进的是系统提示词，而系统提示词既不落盘也不回显到对话里，
 * 于是偏好层成了四层记忆里唯一在 GUI 上完全看不见的层。这个项目最痛的历史故障
 * 就是插件静默不挂载，所以宁可每轮多付一行文本，也要让状态可见。
 * ======================================================================= */
console.log("\n=== 23. 状态标记：注册成 runtime context 而非第二个 section ===");
const ctxStatus = makeCtx();
mod.apply(ctxStatus, { mirror: false });
await tick(30);

const statusDef = ctxStatus._contexts.get("memory:standing-rules-status");
check("注册了 runtime context memory:standing-rules-status", statusDef !== undefined, [...ctxStatus._contexts.keys()]);
check("它注册在 context 集合里，而不是 section 集合里", !ctxStatus._sections.has("memory:standing-rules-status"));
check(
  "order 锚在平台 SUBAGENT_DELEGATION 之后（跟着平台挪号）",
  statusDef?.order === CONTEXT_ORDERS.SUBAGENT_DELEGATION + 10,
  statusDef?.order,
);

const STATUS_CWD = "D:\\work\\proj-status";
const STATUS_OTHER = "D:\\work\\proj-status-other";
const sessStatus = { id: "s-status", header: { cwd: STATUS_CWD } };
const sessStatusOther = { id: "s-status-other", header: { cwd: STATUS_OTHER } };
const wStatus = ctxStatus._tools.get("memory_write");

// 空库：标记仍要出现（否则「空」和「没挂上」就分不清了 —— 这正是要防的混淆）
const s23Empty = ctxStatus._renderStatus(sessStatus);
check("空库时标记仍然出现（空 ≠ 没挂上）", s23Empty.includes("常驻规则层：共 0 条偏好"), s23Empty);
check("空库时版本号为 0", s23Empty.includes("版本 0"), s23Empty);

await wStatus.execute({ id: "status-a", text: "状态基线 A", scope: "global" }, { agent: { session: sessStatus } });
const s23One = ctxStatus._renderStatus(sessStatus);
check("写入后版本号推进到 1（这就是「重新加载」的可见信号）", s23One.includes("版本 1"), s23One);
check("计数只算本工作区可见的条目", s23One.includes("共 1 条偏好（global 1 / 本工作区 0）"), s23One);

await wStatus.execute({ id: "status-b", text: "状态基线 B", scope: "workspace" }, { agent: { session: sessStatus } });
const s23Two = ctxStatus._renderStatus(sessStatus);
check("global 与本工作区分别计数", s23Two.includes("共 2 条偏好（global 1 / 本工作区 1）"), s23Two);
check("版本号推进到 2", s23Two.includes("版本 2"), s23Two);
check("没有未注入条目时不出现「未注入」字样", !s23Two.includes("未注入"), s23Two);

// 另一个工作区：workspace 条目不串味，global 仍可见
const s23Other = ctxStatus._renderStatus(sessStatusOther);
check("另一个工作区只看到 global 条目", s23Other.includes("共 1 条偏好（global 1 / 本工作区 0）"), s23Other);
check("另一个工作区的版本号相同（版本是全局的，不是按 cwd 的）", s23Other.includes("版本 2"), s23Other);

// 删除也要推进版本号，否则标记会说谎
const dStatus = ctxStatus._tools.get("memory_delete");
await dStatus.execute({ id: "status-b" }, { agent: { session: sessStatus } });
check("删除后版本号推进到 3", ctxStatus._renderStatus(sessStatus).includes("版本 3"), ctxStatus._renderStatus(sessStatus));
check("删除后计数同步下降", ctxStatus._renderStatus(sessStatus).includes("共 1 条偏好"), ctxStatus._renderStatus(sessStatus));

// 标记读的是缓存槽位，所以同样是 O(1)：绕过插件的底层改动不该被反映
const statusRaw = [...ctxStatus._files.get("entries")].map(([id, rec]) => ({ id, ...rec }));
const statusKeyA = statusRaw.find((r) => r.id.endsWith("status-a"))?.id;
check("能定位到底层记录（否则下面这条断言无意义）", typeof statusKeyA === "string", statusKeyA);
const s23BeforeBypass = ctxStatus._renderStatus(sessStatus);
ctxStatus._files.get("entries").get(statusKeyA).text = "被绕过改动的正文";
check(
  "标记也没有每步重算（底层改写不进标记）",
  ctxStatus._renderStatus(sessStatus) === s23BeforeBypass,
  s23BeforeBypass,
);

// 超出注入上限时要明说「另有 N 条未注入」——一眼看出容量问题
const ctxStatusCap = makeCtx();
mod.apply(ctxStatusCap, { maxInject: 1, mirror: false });
await tick(30);
const wStatusCap = ctxStatusCap._tools.get("memory_write");
const sessStatusCap = { id: "s-status-cap", header: { cwd: "D:\\work\\proj-status-cap" } };
await wStatusCap.execute({ id: "sc-a", text: "容量 A", scope: "global" }, { agent: { session: sessStatusCap } });
await wStatusCap.execute({ id: "sc-b", text: "容量 B", scope: "global" }, { agent: { session: sessStatusCap } });
const s23Cap = ctxStatusCap._renderStatus(sessStatusCap);
check("超过注入上限时标记出「另有 N 条未注入」", s23Cap.includes("另有 1 条未注入"), s23Cap);
check("同时报出本轮实际注入条数", s23Cap.includes("本轮注入 1 条"), s23Cap);

// 存储域还没打开时：要明说未就绪，且绝不抛错
const ctxStatusLate = makeCtx(undefined, { deferOpen: true });
mod.apply(ctxStatusLate, { mirror: false });
await tick(20);
let lateThrew = null;
let s23Late = "";
try {
  s23Late = ctxStatusLate._renderStatus(sessStatus);
} catch (error) {
  lateThrew = error;
}
check("域未就绪时标记不抛错", lateThrew === null, lateThrew ? String(lateThrew) : "");
check("域未就绪时明说未就绪（而不是静默空串）", s23Late.includes("未就绪"), s23Late);
ctxStatusLate._resolveOpen();

// 老版本 DSH 没有 context()：宁可少这行标记，也绝不能让 apply() 抛错导致整个插件不挂载
const ctxNoContext = makeCtx();
delete ctxNoContext.systemPrompt.context;
let noContextThrew = null;
try {
  mod.apply(ctxNoContext, { mirror: false });
} catch (error) {
  noContextThrew = error;
}
await tick(30);
check("systemPrompt 缺 context() 时 apply 不抛错", noContextThrew === null, noContextThrew ? String(noContextThrew) : "");
check("此时插件照常挂载（3 个工具都在）", ctxNoContext._tools.size === 3, [...ctxNoContext._tools.keys()]);
check("此时照常注册偏好段落（只少状态标记）", ctxNoContext._sections.has("memory:standing-rules"));
check(
  "缺 context() 时留下 warn，不静默",
  ctxNoContext._warns.some((w) => String(w).includes("不支持 context()")),
  ctxNoContext._warns,
);

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"} —— 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
