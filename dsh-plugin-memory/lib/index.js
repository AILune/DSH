/**
 * dsh-plugin-memory —— 常驻规则层（用户偏好与稳定约定）。
 *
 * 用户偏好**不能**依赖检索：检索会静默失败，偏好必须无条件常驻。
 * 因此本层不建索引、不做向量检索，只按作用域全量拼接后每步注入。
 *
 * 与 dsh-plugin-working-memory 的分工：
 *   本插件        —— 稳定约定，小而必须常驻，每步注入
 *   工作记忆插件  —— 当前需求状态，会变会过期，按恢复点注入
 *
 * 职责：把「用户偏好与稳定约定」持久化，并常驻在系统提示词里，
 * 使得用户不必在新会话里重复交代同样的偏好，也不会因压缩而丢失。
 *
 * 设计要点：
 *  - 存储：dsh-storage-domain 的 per-record 域，原子写 + 记录校验 + 序列化写链
 *  - 零第三方依赖：schema 只需提供 parse()，因此不必引入 zod
 *    （依据 dsh-storage-domain/lib/index.js:420 的 parseRecord 实现）
 *  - 注入：注册 systemPrompt 段落（常驻），每步组装时求值，不进入对话消息流
 *  - 存活：系统提示词不参与压缩，因此偏好不会因压缩而丢失，无需靠位置赌保留区
 *  - 写入留痕：写入后在本轮系统提示词里挂提醒，确保模型在写最终回复前看到
 *  - 人可核验：同时写 ~/.dsh/memory/MEMORY.md 只读镜像
 *
 * 明确不做的事（留待后续步骤）：
 *  - 不做向量检索（BGE 本地部署是第二步）
 *  - 不做自动抽取（先由 agent 显式调用 memory_write）
 *  - 不改动会话日志（append-only 且 fail-closed）
 */
import z from "@deepseek-ai/schemastery";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

const name = "memory";

/** 依赖的 service：storageDomain 用于开域，systemPrompt 用于挂载常驻规则层 */
const inject = ["storageDomain", "systemPrompt", "tools"];

/* ------------------------------------------------------ 轻量记录校验器 */
/*
 * dsh-storage-domain 只要求 schema 对象带一个 `parse(value)` 方法：
 *   function parseRecord(domain, table, key, parse) {
 *     try { return parse(); } catch (error) { throw new DomainError("invalid-record", ...); }
 *   }
 * （见 dsh-storage-domain/lib/index.js:420）
 * 因此不必引入 zod —— 手写同形状校验器即可，插件保持零第三方依赖，
 * 避免往 profile 里再装一个包。
 */

/** 把一条记录规范化；不符合形状则抛出（由 domain 层包装成 invalid-record） */
function parseMemoryRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory record 必须是对象");
  }
  const text = value.text;
  if (typeof text !== "string" || text.length === 0) throw new Error("memory record.text 必须是非空字符串");

  const kind = value.kind;
  if (kind !== "working" && kind !== "semantic" && kind !== "episodic") {
    throw new Error(`memory record.kind 非法: ${String(kind)}`);
  }

  const scope = value.scope;
  if (scope !== "global" && scope !== "workspace") throw new Error(`memory record.scope 非法: ${String(scope)}`);

  const evidence = value.evidence;
  if (evidence !== "user-stated" && evidence !== "inferred") {
    throw new Error(`memory record.evidence 非法: ${String(evidence)}`);
  }

  const tags = value.tags === undefined ? [] : value.tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    throw new Error("memory record.tags 必须是字符串数组");
  }

  if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") {
    throw new Error("memory record 的 createdAt/updatedAt 必须是数字");
  }

  return {
    text,
    kind,
    scope,
    ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
    tags,
    evidence,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.lastInjectedAt === "number" ? { lastInjectedAt: value.lastInjectedAt } : {}),
    injectCount: typeof value.injectCount === "number" ? value.injectCount : 0,
    // 注入过这条记忆的会话 id 列表（持久化）。
    // 它是 injectCount 的去重依据，也是让用户能人工核验该计数的唯一凭据 ——
    // 只存数字而不存 id，会让这个计数变成无法验证的黑箱。
    ...(Array.isArray(value.injectedSessions) && value.injectedSessions.every((x) => typeof x === "string")
      ? { injectedSessions: value.injectedSessions }
      : {}),
  };
}

/* ------------------------------------------------------------------ 配置 */

const Config = z.object({
  /** 注入到上下文里的记忆条数上限，避免长期膨胀 */
  maxInject: z.natural().min(1).default(24),
  /** 单条记忆正文的最大字符数 */
  maxEntryChars: z.natural().min(1).default(500),
  /** 是否写人可核验的 MEMORY.md 镜像 */
  mirror: z.boolean().default(true),
  /** 镜像文件路径；不填则用 <DSH home>/memory/MEMORY.md */
  mirrorPath: z.string(),
});

/* ------------------------------------------------------------ 存储域声明 */

/** 记录表：用上面手写的校验器，而不是 zod */
const memoryRecordSchema = { parse: parseMemoryRecord };

const memoryDomainSpec = defineDomain({
  name: "memory",
  version: 1,
  invalidRecords: "backup-and-skip",
  layout: "per-record",
  tables: { entries: domainTable(memoryRecordSchema) },
});

/* ------------------------------------------------------------------ 工具 */

const entrySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    kind: { type: "string" },
    scope: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    evidence: { type: "string" },
    updatedAt: { type: "number" },
    injectCount: { type: "number" },
    lastInjectedAt: { type: "number" },
    injectedSessions: { type: "array", items: { type: "string" } },
  },
  required: ["id", "text", "kind", "scope", "evidence"],
};

/* -------------------------------------------------------------- 工具函数 */

/** 把工作区路径压成可作为存储 key 的短标识 */
function workspaceKeyFor(cwd) {
  const base = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "ws";
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) | 0;
  return `${base}-${(h >>> 0).toString(36)}`;
}

/*
 * 存储 key 的分隔符必须是 "_"，不能是 ":"。
 * per-record 布局要求 key 匹配 /^[a-zA-Z0-9_-]+$/（dsh-storage-json/lib/index.js:535
 * 的 SAFE_KEY_RE），冒号不是路径安全字符，带冒号的 key 会在 putRecord 时抛错。
 */
const KEY_SEP = "_";

/** 把任意用户输入规整成同一个 slug 形状（keyFor 与删除查找共用） */
function normalizeSlug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** 记忆的存储 key：global_<slug> 或 <wsKey>_<slug> */
function keyFor(scope, workspaceKey, slug) {
  const clean = normalizeSlug(slug);
  if (clean === "") throw new Error("memory id/slug 不能为空");
  return scope === "global" ? `global${KEY_SEP}${clean}` : `${workspaceKey}${KEY_SEP}${clean}`;
}

/** 从 key 反推 slug（用于展示和删除） */
function slugOf(key) {
  const i = key.indexOf(KEY_SEP);
  return i === -1 ? key : key.slice(i + 1);
}

/** 解析 <DSH home> */
function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), ".dsh");
}

function textBlock(text) {
  return { type: "text", text };
}


/* ------------------------------------------------------------ 启动探针 */
/*
 * 插件跑在 harness 进程里，stderr 在桌面端不可见，"apply 没被调用" 和
 * "apply 里抛错" 从外部看起来完全一样。因此把关键节点追加到日志文件，
 * 让加载失败可诊断。
 *
 * 默认关闭：只在显式设置 DSH_MEMORY_PROBE=on 时写入，避免长期占用磁盘。
 * 需要排查加载问题时，在启动 DSH 前设 DSH_MEMORY_PROBE=on 即可。
 * 路径可用 DSH_MEMORY_PROBE_FILE 覆盖。
 */
const PROBE_FILE =
  process.env.DSH_MEMORY_PROBE_FILE ??
  path.join(os.tmpdir(), "dsh-plugin-memory-probe.log");
const PROBE_ON = process.env.DSH_MEMORY_PROBE === "on";

function probe(message) {
  if (!PROBE_ON) return;
  try {
    fsSync.appendFileSync(PROBE_FILE, `${new Date().toISOString()}  ${message}\n`, "utf8");
  } catch {
    /* 探针本身绝不能影响插件 */
  }
}

/* ------------------------------------------------------------------ 主体 */

function apply(ctx, config) {
  probe("apply() 被调用了");
  const cfg = config ?? {};
  const maxInject = cfg.maxInject ?? 24;
  const maxEntryChars = cfg.maxEntryChars ?? 500;
  const mirrorOn = cfg.mirror ?? true;
  const mirrorPath = cfg.mirrorPath ?? path.join(resolveDshHome(), "memory", "MEMORY.md");

  /** 打开域并持有表句柄；dispose 时关闭 */
  let table;
  const ready = (async () => {
    try {
      probe(`正要 open 域 'memory'，storageDomain=${typeof ctx.storageDomain}`);
      const domain = await ctx.storageDomain.open(memoryDomainSpec);
      table = domain.table("entries");
      ctx.effect(() => () => domain.close(), "memory: close domain");
      probe("域已打开，表句柄就绪");
    } catch (error) {
      // 绝不吞掉：这是"插件没生效"的头号原因，必须留痕
      probe(`open 域失败: ${error?.name ?? ""} ${error?.message ?? String(error)}`);
      throw error;
    }
  })();
  // 开域失败不能让错误消失在 unhandled rejection 里
  ready.catch(() => {});

  /* ---------------- 常驻规则层：挂到系统提示词 ---------------- */

  /**
   * 本轮已写入、但还没告知用户的变更（按会话 id 记）。
   *
   * 为什么需要它：没有任何钩子能改写模型已经说出去的话（agent/turn-stopping
   * 只发通知，改不了最终回复），所以「轮末自动补一句提示」做不到。
   * 改成「让模型必然看到」：memory_write 返回后必然还有一次模型调用（要读工具
   * 结果才能回话），届时本段落会把提醒渲染进系统提示词，于是提示必然发生在
   * 模型写最终回复之前。轮末清空，避免在别的轮次里谎报写入。
   */
  const pendingNotices = new Map();

  /** 记一笔「已写入但未告知」，等下一步组装系统提示词时提醒模型 */
  function noteWrite(agent, id, kind) {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== "string" || sessionId === "") return;
    // 同一 id 在同一轮里被写多次时只保留最后一次结果，避免提醒里出现重复行
    const list = (pendingNotices.get(sessionId) ?? []).filter((p) => p.id !== id);
    list.push({ id, kind });
    pendingNotices.set(sessionId, list);
  }

  // 轮末清空：否则下一轮会重复提醒，甚至在没写入的轮次里谎报写入
  ctx.on("agent/turn-stopping", ({ agent }) => {
    const sessionId = agent?.session?.id;
    if (typeof sessionId === "string") pendingNotices.delete(sessionId);
  });

  /**
   * 渲染「本轮已写入、尚未告知用户」的提醒。
   *
   * 这是把「写入必须留痕」从助手自觉变成机制的唯一着力点：
   * 钩子改不了模型的最终回复，但能让提醒必然出现在模型写回复之前。
   */
  function renderNotice(pending) {
    const lines = pending.map((p) =>
      p.kind === "deleted" ? `- 已删除 \`${p.id}\`` : `- 已写入/更新 \`${p.id}\``,
    );
    return [
      "## 本轮记忆写入（尚未告知用户）",
      "",
      "你在本轮对跨会话记忆做了以下改动：",
      ...lines,
      "",
      "**你必须在本次回复的最后一行，用一句话明确告知用户这次改动及其 id。**",
      "这是硬性约定：自主完成的写操作必须留下用户可见的痕迹，不得省略。",
    ].join("\n");
  }

  /* ---- 常驻规则层的渲染缓存：开场算一次，写入才重算 ---- */

  /**
   * 内容版本号：只有「会改变渲染结果」的写操作才 +1。
   *
   * session/flush 的注入计数更新**故意不动它** —— 那条路径只改 injectCount /
   * lastInjectedAt，而渲染只读 text/scope/evidence/updatedAt，所以计数变化不该让
   * 系统提示词重算；否则每轮 flush 都会白白作废一次前缀缓存。
   */
  let storeVersion = 0;

  /** cwd -> 槽位 { version, text, total, injected, global, workspace }。内容只由 cwd 决定，故同一工作区的多个会话共用一份 */
  const blockCache = new Map();
  /** 工作区数量极少，64 远超实际；超出只做最简淘汰，不需要真正的 LRU */
  const BLOCK_CACHE_MAX = 64;

  /**
   * 取当前工作区的常驻规则层槽位（带缓存）。
   *
   * 语义是「开场加载一次、之后复用」：只要 storeVersion 没变就直接返回上次算好的
   * 结果，不再每步遍历 + 排序整张表。收益不只是省 CPU：
   *   1) 系统提示词在两次写入之间逐字节恒定，前缀缓存不会被重新渲染的结果扰动；
   *   2) 「什么时候会变」成为显式事件（storeVersion++），而不是渲染逻辑的涌现性质
   *      —— 后者只要有人往 renderBlock 里加一个时间戳，就会静默让每步都失效。
   * 没有条目时缓存空串，于是「空」也走缓存，不必每步重新判断。
   *
   * 槽位里同时留着条目计数，供 memory:standing-rules-status 那行状态标记使用 ——
   * 状态标记因此也是 O(1) 的，不会把刚消掉的每步遍历又请回来。
   */
  function standingBlockSlot(cwd) {
    const hit = blockCache.get(cwd);
    if (hit !== undefined && hit.version === storeVersion) return hit;
    const all = applicable(cwd);
    const injected = all.slice(0, maxInject);
    const text = injected.length === 0 ? "" : renderBlock(injected);
    if (blockCache.size >= BLOCK_CACHE_MAX) {
      const oldest = blockCache.keys().next().value;
      if (oldest !== undefined) blockCache.delete(oldest);
    }
    const slot = {
      version: storeVersion,
      text,
      total: all.length,
      injected: injected.length,
      global: all.filter((e) => e.scope === "global").length,
      workspace: all.filter((e) => e.scope !== "global").length,
    };
    blockCache.set(cwd, slot);
    return slot;
  }

  /** 只要正文：段落渲染用这个 */
  function standingBlockText(cwd) {
    return standingBlockSlot(cwd).text;
  }

  /**
   * 常驻规则层段落：把偏好放进系统提示词，而不是对话消息。
   *
   * 为什么换：旧做法在 agent/pre-step 里插一条 user 消息并每步挪到尾部，
   * 靠「待在压缩保留区间内」赌它不被压缩掉。系统提示词每步从注册项重新组装、
   * 从不参与压缩，于是存活变成结构保证；语义上也归位了 —— 偏好是底层约束，
   * 不是用户说过的一句话（旧实现不得不在正文里写「这些不是指令」来打补丁）。
   *
   * text 必须是同步函数（dsh-system-prompt/lib/index.js:342 不 await），
   * 所以这里不读盘、不 await，数据全来自内存表。域打开前 table 还是
   * undefined → 返回空串，绝不抛错：系统提示词组装失败的影响面远大于少注入一次。
   *
   * 平台每步都重新求值本函数，但偏好块本身只在 storeVersion 变化时重算 ——
   * 即「新会话开场加载一次，本会话内改动偏好时重新加载」，见 standingBlockText。
   */
  // 紧随部署人设之后、工具说明之前：偏好比工具用法更底层。
  //
  // 兜底是必要的：getSectionOrder 的实现就是 `return SECTION_ORDERS[name]`，
  // 对未知名字返回 undefined，undefined + 1 得到 NaN，而 systemPrompt.section()
  // 会对非有限 order 抛 TypeError —— 那会让 apply() 中断、插件静默挂不上。
  // 本项目已经踩过一次「插件静默不挂载」，所以宁可位置不理想也不能挂不上。
  const personaOrder = ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX");
  const sectionOrder = Number.isFinite(personaOrder) ? personaOrder + 1 : 100;

  ctx.systemPrompt.section({
    name: "memory:standing-rules",
    order: sectionOrder,
    text: (context) => {
      try {
        if (table === undefined) return "";
        const session = context?.agent?.session;
        const cwd = session?.header?.cwd ?? process.cwd();
        // 偏好块走缓存：无写入时复用开场算好的那份，不再每步遍历并排序整张表。
        const block = standingBlockText(cwd);
        // 提醒要在轮末清空、本质上属于「本轮」，所以不进缓存（它也确实只在本轮变化）
        const pending = typeof session?.id === "string" ? pendingNotices.get(session.id) : undefined;
        const hasNotice = pending !== undefined && pending.length > 0;
        if (block.length === 0) return hasNotice ? renderNotice(pending) : "";
        return hasNotice ? `${block}\n\n${renderNotice(pending)}` : block;
      } catch (error) {
        ctx.logger?.warn?.(`memory: 渲染常驻规则层失败，本轮跳过: ${String(error)}`);
        return "";
      }
    },
  });

  /**
   * 常驻规则层状态标记：注册成 runtime context，而不是第二个 section。
   *
   * 为什么必须有：偏好块进的是**系统提示词**，而系统提示词既不落盘、也不回显到对话里
   * —— 于是偏好层成了四层记忆里唯一一个在 GUI 上完全看不见的层，「插件到底挂上了没」
   * 只能靠外部探针。而这个项目最痛的历史故障恰恰就是插件静默不挂载，所以宁可每轮多
   * 付一行文本，也要让「在不在、有几条、有没有重新加载」直接可见。
   *
   * context 与 section 是 assemble 产出的两个不同集合
   * （dsh-system-prompt/lib/index.js:338-354）：
   *   section -> renderPrompt      -> 系统提示词（不回显给对话）
   *   context -> joinContextSections -> 「Current runtime context. …」快照（每轮回显）
   * 平台的沙箱策略(110)/审批策略(115)/子代理(120)走的都是 context，正是它们让这段
   * 快照每轮出现。这也是判断「某层可见与否」时最容易踩空的地方。
   *
   * 计数取自已缓存的槽位，所以这一步同样是 O(1)，不会把刚消掉的每步遍历请回来。
   *
   * order 同样要兜住 getContextOrder 对未知名字返回 undefined 的 NaN 坑（见上面
   * section 的注释：非有限 order 会让注册抛 TypeError，进而让 apply() 中断、
   * 插件静默挂不上）。这里锚在平台的 SUBAGENT_DELEGATION 之后，平台整体挪号时
   * 跟着挪，保证始终排在平台内容后面。
   */
  if (typeof ctx.systemPrompt.context !== "function") {
    // 老版本 DSH 没有 context()：宁可少这行标记，也不能让 apply() 抛错导致插件整个不挂载
    ctx.logger?.warn?.("memory: 当前 DSH 的 systemPrompt 不支持 context()，跳过状态标记");
  } else {
    const subagentOrder = ctx.systemPrompt.getContextOrder?.("SUBAGENT_DELEGATION");
    const statusOrder = Number.isFinite(subagentOrder) ? subagentOrder + 10 : 130;

    ctx.systemPrompt.context({
      name: "memory:standing-rules-status",
      order: statusOrder,
      text: (context) => {
        try {
          if (table === undefined) return "常驻规则层：未就绪（存储域尚未打开）";
          const session = context?.agent?.session;
          const cwd = session?.header?.cwd ?? process.cwd();
          const slot = standingBlockSlot(cwd);
          const head = `常驻规则层：共 ${slot.total} 条偏好（global ${slot.global} / 本工作区 ${slot.workspace}），本轮注入 ${slot.injected} 条`;
          const more = slot.total > slot.injected ? `，另有 ${slot.total - slot.injected} 条未注入` : "";
          return `${head}${more} · 版本 ${slot.version}`;
        } catch (error) {
          ctx.logger?.warn?.(`memory: 渲染常驻规则层状态标记失败，本轮跳过: ${String(error)}`);
          return "";
        }
      },
    });
  }

  /* ---------------- 读写辅助 ---------------- */

  /** 取出适用于当前工作区的记忆，global 优先，再按更新时间倒序 */
  function applicable(cwd) {
    const wsKey = workspaceKeyFor(cwd);
    const out = [];
    for (const [key, rec] of table.entries()) {
      if (rec.scope === "global") out.push({ id: key, ...rec });
      else if (key.startsWith(`${wsKey}${KEY_SEP}`)) out.push({ id: key, ...rec });
    }
    out.sort((a, b) => (a.scope === b.scope ? b.updatedAt - a.updatedAt : a.scope === "global" ? -1 : 1));
    return out;
  }

  function renderBlock(entries) {
    const lines = entries.map((e) => {
      const tag = e.evidence === "inferred" ? "（助手推断，待确认）" : "";
      const scope = e.scope === "workspace" ? "[本工作区] " : "";
      const text = e.text.length > maxEntryChars ? `${e.text.slice(0, maxEntryChars)}…` : e.text;
      return `- ${scope}${text}${tag}`;
    });
    return [
      "## 常驻规则层（用户偏好与稳定约定）",
      "",
      "以下是用户此前明确表达过的偏好与稳定约定，**无条件生效**：不经过检索，"
        + "因此不会因召回失败而静默失效。",
      "把它们当作约束，不是待办；若与用户当前的要求冲突，以当前要求为准。",
      "（当前需求与进度状态另见「工作记忆」层，那是另一个插件。）",
      "",
      ...lines,
    ].join("\n");
  }

  /**
   * 把注入计数渲染成「可人工核验」的单元格：数字 + 会话 id 前缀。
   * 只写一个数字，用户就无法核对这个数字是怎么来的 —— 而本计数的用途
   * 正是「让用户判断这条记忆有没有被真正用到」。
   */
  function injectionCell(e) {
    const count = e.injectCount ?? 0;
    const ids = (e.injectedSessions ?? []).map((s) => String(s).replace(/^session-/, "").slice(0, 8));
    if (count === 0) return "0";
    if (ids.length === 0) return `${count}（历史计数，无 id 记录）`;
    const shown = ids.slice(0, 5).join(", ");
    return `${count}（${shown}${ids.length > 5 ? `, +${ids.length - 5}` : ""}）`;
  }

  /** 写人可核验的只读镜像 */
  async function writeMirror() {
    if (!mirrorOn) return;
    const all = [...table.entries()].map(([key, rec]) => ({ id: key, ...rec }));
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    const doc = [
      "# MEMORY.md —— 跨会话记忆镜像（只读）",
      "",
      `<!-- 由 dsh-plugin-memory 自动生成于 ${new Date().toISOString()} -->`,
      "<!-- 这是一个只读镜像；权威副本在 domain 文件里，直接编辑本文件不会生效。 -->",
      "<!-- 要删除某条记忆，用 memory_delete 工具，或告诉我。 -->",
      "",
      `共 ${all.length} 条。`,
      "",
      "> 「注入会话数」= 这条记忆被注入过的**不同会话**数；括号里是会话 id 的前 8 位，可据此人工核验。",
      "> 去重依据是持久化的 `injectedSessions` 列表（不是内存里的 Set），所以进程重启、插件热加载都不会重复计数。",
      "> 权威副本（含完整会话 id）在 domain 文件里；本文件是只读镜像。",
      "",
      "| id | 类型 | 范围 | 正文 | 证据 | 注入会话数（id 前缀） |",
      "|---|---|---|---|---|---|",
      ...all.map(
        (e) =>
          `| \`${e.id}\` | ${e.kind} | ${e.scope} | ${e.text.replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${e.evidence} | ${injectionCell(e)} |`,
      ),
      "",
    ].join("\n");
    try {
      await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
      await fs.writeFile(mirrorPath, doc, "utf8");
    } catch (error) {
      ctx.logger?.warn?.(`memory: 写镜像失败 ${mirrorPath}: ${String(error)}`);
    }
  }

  /* ---------------- 工具注册 ---------------- */

  const disposers = [];

  function register(definition) {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === "function") disposers.push(dispose);
  }

  register({
    name: "memory_write",
    description:
      "把一条跨会话的工作记忆（用户偏好或稳定约定）持久化，之后每个新会话都会自动带上。仅在用户明确表达偏好/约定时写入；不要把推测写成 user-stated。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "短标识（英文/数字/连字符），同名会覆盖更新" },
        text: { type: "string", description: "一句话正文，写成陈述句" },
        scope: {
          type: "string",
          enum: ["global", "workspace"],
          description: "global=所有工作区通用；workspace=仅当前工作区。默认 global",
        },
        tags: { type: "array", items: { type: "string" }, description: "召回用标签" },
        evidence: {
          type: "string",
          enum: ["user-stated", "inferred"],
          description: "user-stated=用户明说；inferred=助手推断。默认 user-stated",
        },
      },
      required: ["id", "text"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          created: { type: "boolean" },
          total: { type: "number" },
          path: { type: "string" },
        },
        required: ["id", "created", "total"],
      },
      render: (_args, value) => [
        textBlock(
          `${value.created ? "已写入" : "已更新"}记忆 \`${value.id}\`（共 ${value.total} 条）` +
            (value.path ? `\n镜像：${value.path}` : ""),
        ),
      ],
    },
    async execute(args, execCtx) {
      await ready;
      const cwd = execCtx?.agent?.session?.header?.cwd;
      const scope = args.scope === "workspace" ? "workspace" : "global";
      const wsKey = workspaceKeyFor(cwd ?? process.cwd());
      const key = keyFor(scope, wsKey, args.id);
      const now = Date.now();
      const prev = table.get(key);
      const record = {
        text: String(args.text).trim(),
        kind: "working",
        scope,
        ...(scope === "workspace" ? { workspace: cwd ?? process.cwd() } : {}),
        tags: Array.isArray(args.tags) ? args.tags.map(String) : (prev?.tags ?? []),
        evidence: args.evidence === "inferred" ? "inferred" : "user-stated",
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        ...(prev?.lastInjectedAt === undefined ? {} : { lastInjectedAt: prev.lastInjectedAt }),
        injectCount: prev?.injectCount ?? 0,
        // 改写正文不应该抹掉「哪些会话用过它」的历史，否则计数会与凭据脱节
        ...(prev?.injectedSessions === undefined ? {} : { injectedSessions: prev.injectedSessions }),
      };
      await table.put(key, record);
      await writeMirror();
      // 写入会改变渲染结果 → 推进版本号，作废缓存，下一次组装立刻反映新内容
      storeVersion += 1;
      // 记一笔「已写入但未告知」：下一次组装系统提示词时会提醒模型在本轮回复里说明
      noteWrite(execCtx?.agent, key, prev === undefined ? "created" : "updated");
      return {
        id: key,
        created: prev === undefined,
        total: table.size,
        path: mirrorOn ? mirrorPath : undefined,
      };
    },
  });

  register({
    name: "memory_recall",
    description: "读取当前生效的跨会话记忆（含全局与当前工作区）。可选按关键词过滤。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "可选关键词，按正文与标签做子串过滤" },
        scope: { type: "string", enum: ["global", "workspace", "all"], description: "默认 all" },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          total: { type: "number" },
          entries: { type: "array", items: entrySchema },
        },
        required: ["total", "entries"],
      },
      render: (_args, value) =>
        value.total === 0
          ? [textBlock("（没有匹配的记忆）")]
          : [
              textBlock(
                value.entries
                  .map(
                    (e) =>
                      `- \`${e.id}\` [${e.scope}/${e.evidence}] ${e.text}` +
                      (e.tags?.length ? `  #${e.tags.join(" #")}` : ""),
                  )
                  .join("\n"),
              ),
            ],
    },
    async execute(args, execCtx) {
      await ready;
      const cwd = execCtx?.agent?.session?.header?.cwd;
      let list = applicable(cwd ?? process.cwd());
      if (args.scope && args.scope !== "all") list = list.filter((e) => e.scope === args.scope);
      if (args.query) {
        const q = String(args.query).toLowerCase();
        list = list.filter(
          (e) =>
            e.text.toLowerCase().includes(q) ||
            (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
        );
      }
      return { total: list.length, entries: list };
    },
  });

  register({
    name: "memory_delete",
    description: "删除一条跨会话记忆。id 可用完整 key，也可只用冒号后的短标识。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "完整 key 或短标识" } },
      required: ["id"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          deleted: { type: "boolean" },
          id: { type: "string" },
          total: { type: "number" },
        },
        required: ["deleted", "id", "total"],
      },
      render: (_args, value) => [
        textBlock(value.deleted ? `已删除记忆 \`${value.id}\`（剩 ${value.total} 条）` : `未找到记忆 \`${value.id}\``),
      ],
    },
    async execute(args, execCtx) {
      await ready;
      const want = String(args.id);
      let key = want;
      if (!table.get(key)) {
        // 允许只给短标识：全局优先，其次任意工作区
        const wantSlug = normalizeSlug(slugOf(want));
        const matches = [...table.keys()].filter((k) => slugOf(k) === wantSlug);
        key = matches.find((k) => k.startsWith(`global${KEY_SEP}`)) ?? matches[0] ?? want;
      }
      const deleted = await table.delete(key);
      await writeMirror();
      // 删除同样改变渲染结果 → 作废缓存（没真删掉就不动，避免无谓重算）
      if (deleted) storeVersion += 1;
      // 删除同样要留痕：静默删掉一条偏好，等于让偏好悄悄失效
      if (deleted) noteWrite(execCtx?.agent, key, "deleted");
      return { deleted, id: key, total: table.size };
    },
  });

  /* ---------------- 会话结束前更新注入计数 ---------------- */

  /**
   * 每条记忆最多保留多少个「注入过它的会话 id」。
   *
   * 去重依据是「记录里持久化的 injectedSessions 列表」，不是内存里的 Set ——
   * 内存 Set 活不过进程，每次进程重启 / 插件热加载都会清零，导致同一个会话被反复计数。
   * 2026-10-04 实测：按会话日志最多只可能有 4 个会话被注入，计数却涨到了 8。
   *
   * 单个 id 约 44 字节，128 条约 5.6 KB。超出上限时丢最早的 ——
   * 被丢掉的 id 若再次出现会被重新计数，但这只在会话数超过上限时才可能发生。
   */
  const MAX_INJECTED_SESSIONS = 128;

  ctx.on("session/flush", async (session) => {
    try {
      await ready;
      const sessionId = session?.id;
      const cwd = session?.header?.cwd ?? process.cwd();

      // 本会话会被注入哪些条目 = 系统提示词里实际渲染的那些。
      // 直接由 cwd 重算，不再依赖 projection 记录「注入过什么」：
      // 少一份需要同步的状态，就少一个可能与实际渲染脱节的地方。
      const entryIds = applicable(cwd).slice(0, maxInject).map((e) => e.id);
      if (entryIds.length === 0) return;

      const now = Date.now();
      for (const key of entryIds) {
        if (table.get(key) === undefined) continue;
        // 注意：table.update 要求传入「更新函数」而不是新值
        // （见 dsh-storage-domain/lib/index.js:278 —— const next = fn(records.get(key))）
        await table.update(key, (prev) => {
          const seen = Array.isArray(prev.injectedSessions) ? prev.injectedSessions : [];
          // 本会话此前已计入 → 列表不变，只刷新「最后一次注入时刻」。
          // 去重依据读的是盘上的列表，所以重启 / 热加载都不会重复计数。
          const already = typeof sessionId !== "string" || seen.includes(sessionId);
          const grown = already ? seen : [...seen, sessionId];
          const kept = grown.length > MAX_INJECTED_SESSIONS ? grown.slice(-MAX_INJECTED_SESSIONS) : grown;
          return {
            ...prev,
            injectedSessions: kept,
            // injectCount 一律由列表长度**推导**，不用累加。
            // 累加的破法：列表有 128 上限，超出后旧 id 会被裁掉，被裁掉的会话再来
            // 会被重复计数，计数还会与列表脱钩（实测 130 个会话 → injectCount=130
            // 而列表只有 128）。推导保证「injectCount === injectedSessions.length」
            // 恒成立，用户才能照着文件数一遍来核验；顺带自愈历史上已脱钩的记录。
            injectCount: kept.length,
            lastInjectedAt: now,
          };
        });
      }

      await writeMirror();
    } catch (error) {
      ctx.logger?.warn?.(`memory: 更新注入计数失败: ${String(error)}`);
    }
  });

  probe(
    `apply() 完成：注册了 ${disposers.length} 个工具，` +
      `section=${ctx.systemPrompt !== undefined}，hooks=agent/turn-stopping+session/flush`,
  );

  return () => {
    probe("disposer 被调用了（插件被卸载）");
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* 逐个释放，忽略单个失败 */
      }
    }
  };
}

export { Config, apply, inject, name };
