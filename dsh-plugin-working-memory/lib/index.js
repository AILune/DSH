/**
 * dsh-plugin-working-memory —— 跨会话的工作记忆
 *
 * 设计取自服务端 Harness 的状态层，对应关系：
 *   AGENTS.md           → .dsh/WORKING.md（入口地图，只读，自动生成）
 *   branch-state.json   → <session>/session-state.json（本会话状态 + 需求清单 + 快照）
 *   handoff.md          → <session>/handoff.md（当前 active 需求详情，覆盖写）
 *
 * 目录布局（工作区内）：
 *   .dsh/WORKING.md                      入口地图，只读
 *   .dsh/work/<session-id>/session-state.json
 *   .dsh/work/<session-id>/handoff.md
 *
 * 两个关键设计：
 *  1. handoff.md 是**覆盖写**的，切走的需求详情会丢。因此 session-state.json
 *     为每个需求留一份 handoffSnapshot，切回时据此完整恢复（不只是恢复一个状态标签）。
 *  2. 不做跨会话索引：每个会话独立，新会话从自己的文件夹开始。
 *
 * 与 dsh-plugin-memory（偏好层）的分工：
 *   偏好层  —— 稳定约定，小而必须常驻，每步注入
 *   工作记忆 —— 当前需求状态，会变会过期，按恢复点注入（会话首步 / 上下文压缩后）
 *
 * @module dsh-plugin-working-memory
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const name = "working-memory";
export const inject = ["sessionProjections", "tools"];

export const Config = z.object({
  /** 生成入口地图的文件名（相对工作区根） */
  entryFile: z.string().default(".dsh/WORKING.md"),
  /** 状态目录（相对工作区根），其下按会话 id 分文件夹 */
  stateDir: z.string().default(".dsh/work"),
  /** 注入时需求详情的最大字符数 */
  maxDetailChars: z.natural().min(1).default(4000),
  /** 注入时各列表最多展示多少条 */
  maxItems: z.natural().min(1).default(8),
});

/* ---------------------------------------------------------------- 常量 */

const STATE_FILE = "session-state.json";
const HANDOFF_FILE = "handoff.md";
const DEFAULT_STATUS = "进行中";

/* ------------------------------------------------------------ 形状校验 */

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((x) => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

function str(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 需求详情（handoff 的结构化形式） */
function emptyDetail() {
  return { goal: "", status: DEFAULT_STATUS, decisions: [], done: [], blockers: [], next: [], files: [], updatedAt: 0 };
}

function parseDetail(value) {
  const base = emptyDetail();
  if (value === null || typeof value !== "object") return base;
  return {
    goal: str(value.goal, base.goal),
    status: str(value.status, "").trim() === "" ? base.status : value.status.trim(),
    decisions: asStringList(value.decisions),
    done: asStringList(value.done),
    blockers: asStringList(value.blockers),
    next: asStringList(value.next),
    files: asStringList(value.files),
    updatedAt: num(value.updatedAt),
  };
}

/** 一个需求记录：索引信息 + 切走时的详情快照 */
function parseDemand(value) {
  const v = value ?? {};
  return {
    id: str(v.id),
    name: str(v.name),
    query: str(v.query),
    status: str(v.status, DEFAULT_STATUS),
    createdAt: num(v.createdAt),
    updatedAt: num(v.updatedAt),
    handoffSnapshot: parseDetail(v.handoffSnapshot),
  };
}

/** 会话状态文件 */
function parseSessionState(value) {
  const v = value ?? {};
  const session = v.session ?? {};
  const demands = Array.isArray(v.demands) ? v.demands.filter((d) => d !== null && typeof d === "object").map(parseDemand) : [];
  const activeDemandId = str(v.activeDemandId);
  return {
    version: num(v.version, 1),
    session: {
      id: str(session.id),
      title: str(session.title),
      startedAt: num(session.startedAt),
      updatedAt: num(session.updatedAt),
    },
    activeDemandId: demands.some((d) => d.id === activeDemandId) ? activeDemandId : (demands[0]?.id ?? ""),
    demands,
  };
}

function emptySessionState(sessionId, title) {
  const now = Date.now();
  return {
    version: 1,
    session: { id: sessionId, title: title ?? "", startedAt: now, updatedAt: now },
    activeDemandId: "",
    demands: [],
  };
}

/* ------------------------------------------------------------ 会话投影 */

const INJECTION_KEY = "workingMemoryInjection";

function parseInjectionState(value) {
  const v = value ?? {};
  const injectedAt = v.injectedAt;
  if (injectedAt !== null && typeof injectedAt !== "number") throw new Error("injectedAt 必须是数字或 null");
  return {
    injectedAt,
    demandId: str(v.demandId, "") || null,
    fingerprint: str(v.fingerprint),
    compactionSeq: typeof v.compactionSeq === "number" ? v.compactionSeq : null,
  };
}

/* -------------------------------------------------------------- 小工具 */

function textBlock(text) {
  return { type: "text", text };
}

/**
 * 在 base 里找"本步新加入的消息"的最后一条位置。
 * `messages` 是 dsh-agent-loop 传入的本步新领到的消息（claimed），不是整个历史。
 */
function findLastNewMessageIndex(base, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;
  const known = new Set(messages);
  for (let i = base.length - 1; i >= 0; i -= 1) {
    if (!known.has(base[i])) return i;
  }
  return -1;
}

/** 状态指纹：需求详情一变指纹就变，据此决定是否需要重注入 */
function fingerprintOf(demandId, detail) {
  return JSON.stringify([demandId, detail.updatedAt, detail.status, detail.next.length, detail.blockers.length]);
}

/** 会话 id 作为目录名，需要是路径安全的 */
function safeDirName(sessionId) {
  const s = String(sessionId ?? "").replace(/[^a-zA-Z0-9_-]/g, "-");
  if (s === "") throw new Error("会话 id 为空，无法确定工作记忆目录");
  return s;
}

/* ------------------------------------------------------------------ 主体 */

export function apply(ctx, config) {
  const cfg = config ?? {};
  const entryFile = cfg.entryFile ?? ".dsh/WORKING.md";
  const stateDir = cfg.stateDir ?? ".dsh/work";
  const maxDetailChars = cfg.maxDetailChars ?? 4000;
  const maxItems = cfg.maxItems ?? 8;

  /** 缓存：cwd -> { root, sessions: Map<sessionId, {dir, state, detail}> } */
  const cache = new Map();

  function rootFor(cwd) {
    const hit = cache.get(cwd);
    if (hit !== undefined) return hit;
    const created = { root: path.join(cwd, stateDir), sessions: new Map() };
    cache.set(cwd, created);
    return created;
  }

  function sessionPaths(cwd, sessionId) {
    const dir = path.join(rootFor(cwd).root, safeDirName(sessionId));
    return { dir, state: path.join(dir, STATE_FILE), handoff: path.join(dir, HANDOFF_FILE) };
  }

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  /** 载入（并缓存）某会话的状态与当前需求详情 */
  function loadSession(cwd, sessionId, title) {
    const memo = rootFor(cwd).sessions;
    const hit = memo.get(sessionId);
    if (hit !== undefined) return hit;
    const p = sessionPaths(cwd, sessionId);
    const raw = readJson(p.state, null);
    // 文件不存在 → 这是一个全新会话，用 emptySessionState 起头（它会填 startedAt）。
    // 若文件存在但字段残缺（外部手工编辑），则按已有内容解析，不重置会话起始时间。
    const state = raw === null ? emptySessionState(sessionId, title) : parseSessionState(raw);
    if (state.session.id === "") state.session.id = sessionId;
    if (state.session.title === "" && typeof title === "string") state.session.title = title;
    if (state.session.startedAt === 0) state.session.startedAt = Date.now();
    const active = state.demands.find((d) => d.id === state.activeDemandId);
    const detail = active === undefined ? emptyDetail() : parseDetail(readJson(p.handoff, active.handoffSnapshot));
    const entry = { p, state, detail };
    memo.set(sessionId, entry);
    // 首次在本进程里看到这个会话 → 顺手刷新入口地图。
    // 这样即便用户从不调用工具，.dsh/WORKING.md 也会出现，可作为"插件确实加载了"的证据。
    // 每个会话每进程只做一次，不放进每步的注入路径。
    void writeEntryMap(cwd).catch((error) => {
      ctx.logger?.warn?.(`working-memory: 刷新入口地图失败: ${String(error)}`);
    });
    return entry;
  }

  /** 把当前 detail 写回 state 里 active 需求的快照，并落盘两个文件 */
  async function persist(cwd, sessionId, entry) {
    const active = entry.state.demands.find((d) => d.id === entry.state.activeDemandId);
    if (active !== undefined) {
      active.handoffSnapshot = entry.detail;
      active.status = entry.detail.status;
      active.updatedAt = entry.detail.updatedAt;
    }
    entry.state.session.updatedAt = Date.now();
    await fsp.mkdir(entry.p.dir, { recursive: true });
    await fsp.writeFile(entry.p.state, JSON.stringify(entry.state, null, 2) + "\n", "utf8");
    if (active !== undefined) await fsp.writeFile(entry.p.handoff, renderHandoff(entry.state.session, active, entry.detail), "utf8");
    await writeEntryMap(cwd);
  }

  /** handoff.md —— 当前 active 需求的详情，覆盖写 */
  function renderHandoff(session, demand, detail) {
    const list = (xs) => (xs.length === 0 ? "- （无）" : xs.map((x) => `- ${x}`).join("\n"));
    const iso = (t) => (t === 0 ? "—" : new Date(t).toISOString());
    return [
      `# 当前需求：${demand.name || demand.id}`,
      "",
      "<!-- 由 dsh-plugin-working-memory 覆盖写入：切换需求时会整体重写本文件 -->",
      "<!-- 每个需求的详情快照另存于 session-state.json，切回时据此恢复 -->",
      `<!-- 会话: ${session.id} -->`,
      `<!-- 需求 id: ${demand.id} -->`,
      `<!-- 需求处理时间: 创建 ${iso(demand.createdAt)} / 更新 ${iso(demand.updatedAt)} -->`,
      "",
      "## 需求目标",
      "",
      detail.goal || "（未填写）",
      "",
      "## 需求状态",
      "",
      detail.status,
      "",
      "## 关键决策",
      "",
      list(detail.decisions),
      "",
      "## 已完成",
      "",
      list(detail.done),
      "",
      "## 卡点",
      "",
      list(detail.blockers),
      "",
      "## 下一步",
      "",
      list(detail.next),
      "",
      "## 涉及文件",
      "",
      list(detail.files),
      "",
    ].join("\n");
  }

  /** 入口地图：列出所有会话与其当前需求，供人一眼看到（只读） */
  async function writeEntryMap(cwd) {
    const root = rootFor(cwd).root;
    const lines = [
      "# WORKING.md —— 工作记忆入口（只读）",
      "",
      "<!-- 由 dsh-plugin-working-memory 自动生成；直接编辑不会生效 -->",
      `<!-- 生成于 ${new Date().toISOString()} -->`,
      "",
      `每个会话一个文件夹，位于 \`${stateDir}/<会话id>/\`：`,
      "",
      `- \`${STATE_FILE}\` —— 会话状态、需求清单、各需求详情快照`,
      `- \`${HANDOFF_FILE}\` —— 当前 active 需求的详情（覆盖写）`,
      "",
      "## 全部会话",
      "",
      "| 会话 id | 标题 | 当前需求 | 需求数 | 最后更新 |",
      "|---|---|---|---|---|",
    ];
    let dirs = [];
    try {
      dirs = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      dirs = [];
    }
    const rows = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const raw = readJson(path.join(root, d.name, STATE_FILE), null);
      if (raw === null) continue;
      const st = parseSessionState(raw);
      const active = st.demands.find((x) => x.id === st.activeDemandId);
      const when = st.session.updatedAt === 0 ? "—" : new Date(st.session.updatedAt).toLocaleString("zh-CN");
      rows.push(`| \`${d.name}\` | ${st.session.title || "—"} | ${active ? `${active.name}${active.status ? `（${active.status}）` : ""}` : "—"} | ${st.demands.length} | ${when} |`);
    }
    lines.push(...(rows.length === 0 ? ["| （暂无） | | | | |"] : rows));
    lines.push("");
    try {
      await fsp.mkdir(path.dirname(path.join(cwd, entryFile)), { recursive: true });
      await fsp.writeFile(path.join(cwd, entryFile), lines.join("\n"), "utf8");
    } catch (error) {
      ctx.logger?.warn?.(`working-memory: 写入入口地图失败: ${String(error)}`);
    }
  }

  /* ---------------------------------------------------------------- 工具 */

  const disposers = [];
  function register(definition) {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === "function") disposers.push(dispose);
  }

  function sessionOf(context) {
    const s = context?.agent?.session;
    const id = s?.id;
    if (typeof id !== "string" || id === "") throw new Error("拿不到会话 id，无法定位工作记忆目录");
    const title = str(s?.title, "") || str(s?.header?.title, "") || str(s?.header?.name, "");
    const cwd = s?.header?.cwd ?? s?.cwd ?? process.cwd();
    return { id, title, cwd };
  }

  function slugify(value) {
    const s = String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (s === "") throw new Error("需求 id 不能为空");
    return s;
  }

  register({
    name: "working_memory_start",
    description:
      "在当前会话下登记一个需求（可理解为开一条新分支），并把 handoff.md 指向它。已有需求会用其快照恢复，不做覆盖。开新会话等于开新分支，因此每个新需求都应先调用它建档。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "需求短标识（英文/数字/连字符），同名则切回该需求" },
        name: { type: "string", description: "需求名，一句话" },
        query: { type: "string", description: "需求的原始 query（用户原话），便于日后恢复当时意图" },
        goal: { type: "string", description: "需求目标" },
      },
      required: ["id"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          created: { type: "boolean" },
          status: { type: "string" },
          statePath: { type: "string" },
          handoffPath: { type: "string" },
        },
        required: ["id", "created", "status", "statePath", "handoffPath"],
      },
      render: (_args, value) => [
        textBlock(
          `${value.created ? "已建档" : "已切回"}需求 \`${value.id}\`（状态：${value.status}）\n` +
            `会话状态：${value.statePath}\n需求详情：${value.handoffPath}`,
        ),
      ],
    },
    async execute(args, context) {
      const { id: sessionId, title, cwd } = sessionOf(context);
      const entry = loadSession(cwd, sessionId, title);
      const wantId = slugify(args.id);
      const now = Date.now();
      let demand = entry.state.demands.find((d) => d.id === wantId);
      const created = demand === undefined;
      if (demand === undefined) {
        demand = {
          id: wantId,
          name: str(args.name, "") || wantId,
          query: str(args.query, ""),
          status: DEFAULT_STATUS,
          createdAt: now,
          updatedAt: now,
          handoffSnapshot: emptyDetail(),
        };
        entry.state.demands.push(demand);
      } else {
        if (typeof args.name === "string" && args.name.trim() !== "") demand.name = args.name.trim();
        if (typeof args.query === "string" && args.query.trim() !== "") demand.query = args.query.trim();
      }
      entry.state.activeDemandId = demand.id;
      // 切回已有需求 → 用它的快照恢复详情，而不是留空
      entry.detail = created ? emptyDetail() : parseDetail(demand.handoffSnapshot);
      if (typeof args.goal === "string" && args.goal.trim() !== "") entry.detail.goal = args.goal.trim();
      entry.detail.updatedAt = now;
      await persist(cwd, sessionId, entry);
      return { id: demand.id, created, status: entry.detail.status, statePath: entry.p.state, handoffPath: entry.p.handoff };
    },
  });

  register({
    name: "working_memory_save",
    description:
      "更新当前 active 需求的详情（目标/状态/关键决策/已完成/卡点/下一步/涉及文件），同步写入 handoff.md 与快照。传入的字段替换旧值，未传的保持不动。会话结束前应把状态写进来。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "需求 id；省略则用当前 active 需求" },
        goal: { type: "string", description: "需求目标（替换）" },
        status: { type: "string", description: "需求状态（替换），如：进行中 / 已完成 / 已暂停 / 已阻塞" },
        decisions: { type: "array", items: { type: "string" }, description: "关键决策（整段替换）" },
        done: { type: "array", items: { type: "string" }, description: "已完成（整段替换）" },
        blockers: { type: "array", items: { type: "string" }, description: "卡点（整段替换）" },
        next: { type: "array", items: { type: "string" }, description: "下一步（整段替换）" },
        files: { type: "array", items: { type: "string" }, description: "涉及文件（整段替换）" },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          updatedAt: { type: "number" },
          handoffPath: { type: "string" },
        },
        required: ["id", "status", "updatedAt", "handoffPath"],
      },
      render: (_args, value) => [
        textBlock(`已更新需求 \`${value.id}\`（状态：${value.status}）\n需求详情：${value.handoffPath}`),
      ],
    },
    async execute(args, context) {
      const { id: sessionId, title, cwd } = sessionOf(context);
      const entry = loadSession(cwd, sessionId, title);
      if (args.id !== undefined) {
        const want = slugify(args.id);
        const target = entry.state.demands.find((d) => d.id === want);
        if (target === undefined) throw new Error(`需求 ${want} 不存在：请先用 working_memory_start 建档`);
        if (target.id !== entry.state.activeDemandId) {
          entry.state.activeDemandId = target.id;
          entry.detail = parseDetail(target.handoffSnapshot);
        }
      }
      if (entry.state.activeDemandId === "") throw new Error("当前没有 active 需求：请先用 working_memory_start 建档");
      if (typeof args.goal === "string") entry.detail.goal = args.goal;
      if (typeof args.status === "string" && args.status.trim() !== "") entry.detail.status = args.status.trim();
      for (const field of ["decisions", "done", "blockers", "next", "files"]) {
        if (args[field] !== undefined) entry.detail[field] = asStringList(args[field]);
      }
      entry.detail.updatedAt = Date.now();
      await persist(cwd, sessionId, entry);
      return { id: entry.state.activeDemandId, status: entry.detail.status, updatedAt: entry.detail.updatedAt, handoffPath: entry.p.handoff };
    },
  });

  register({
    name: "working_memory_list",
    description:
      "列出当前会话下处理过的所有需求（需求名、状态、原始 query、处理时间）以及当前 active 需求。用于在 handoff 被覆盖写之后，决定切回哪个需求。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: {
        type: "object",
        properties: {
          activeDemandId: { type: "string" },
          demands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                query: { type: "string" },
                status: { type: "string" },
                createdAt: { type: "number" },
                updatedAt: { type: "number" },
                isActive: { type: "boolean" },
                nextCount: { type: "number" },
                blockerCount: { type: "number" },
              },
              required: ["id", "name", "query", "status", "createdAt", "updatedAt", "isActive", "nextCount", "blockerCount"],
            },
          },
          statePath: { type: "string" },
          handoffPath: { type: "string" },
        },
        required: ["activeDemandId", "demands", "statePath", "handoffPath"],
      },
      render: (_args, value) => [
        textBlock(
          `本会话共 ${value.demands.length} 个需求，当前 active：\`${value.activeDemandId || "（无）"}\`\n` +
            value.demands
              .map((d) => `- ${d.isActive ? "▶ " : "  "}\`${d.id}\` ${d.name}（${d.status}）`)
              .join("\n") +
            `\n会话状态：${value.statePath}\n需求详情：${value.handoffPath}`,
        ),
      ],
    },
    async execute(_args, context) {
      const { id: sessionId, title, cwd } = sessionOf(context);
      const entry = loadSession(cwd, sessionId, title);
      return {
        activeDemandId: entry.state.activeDemandId,
        demands: entry.state.demands.map((d) => ({
          id: d.id,
          name: d.name,
          query: d.query,
          status: d.status,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          isActive: d.id === entry.state.activeDemandId,
          nextCount: d.handoffSnapshot.next.length,
          blockerCount: d.handoffSnapshot.blockers.length,
        })),
        statePath: entry.p.state,
        handoffPath: entry.p.handoff,
      };
    },
  });

  register({
    name: "working_memory_recall",
    description: "读取当前会话的工作记忆：当前 active 需求的完整详情，以及同会话下其他需求的索引。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "需求 id；省略则读当前 active 需求" } },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          demand: {
            type: "object",
            properties: {
              found: { type: "boolean" },
              id: { type: "string" },
              name: { type: "string" },
              query: { type: "string" },
              goal: { type: "string" },
              status: { type: "string" },
              decisions: { type: "array", items: { type: "string" } },
              done: { type: "array", items: { type: "string" } },
              blockers: { type: "array", items: { type: "string" } },
              next: { type: "array", items: { type: "string" } },
              files: { type: "array", items: { type: "string" } },
              createdAt: { type: "number" },
              updatedAt: { type: "number" },
              isActive: { type: "boolean" },
            },
            required: ["found", "id", "name", "query", "goal", "status", "decisions", "done", "blockers", "next", "files", "createdAt", "updatedAt", "isActive"],
          },
          others: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                status: { type: "string" },
                updatedAt: { type: "number" },
              },
              required: ["id", "name", "status", "updatedAt"],
            },
          },
          statePath: { type: "string" },
          handoffPath: { type: "string" },
        },
        required: ["demand", "others", "statePath", "handoffPath"],
      },
      render: (_args, value) => [
        textBlock(
          value.demand.found
            ? `需求 \`${value.demand.id}\`（${value.demand.status}${value.demand.isActive ? "，当前 active" : "，非 active"}）\n` +
                `目标：${value.demand.goal || "（未填写）"}\n` +
                `下一步：${value.demand.next.length === 0 ? "（无）" : value.demand.next.join("；")}\n` +
                // handoff.md 只保存 active 需求；非 active 的详情在 session-state.json 的快照里
                (value.demand.isActive
                  ? `需求详情：${value.handoffPath}`
                  : `该需求非当前 active，handoff.md 里没有它。完整快照在：${value.statePath} 的 demands[].handoffSnapshot`)
            : `未找到需求 \`${_args.id ?? ""}\`。本会话共有 ${value.others.length} 个其他需求。\n会话状态：${value.statePath}`,
        ),
      ],
    },
    async execute(args, context) {
      const { id: sessionId, title, cwd } = sessionOf(context);
      const entry = loadSession(cwd, sessionId, title);
      const wantId = args.id !== undefined ? slugify(args.id) : entry.state.activeDemandId;
      const strList = (xs) => xs;
      const notFound = {
        found: false,
        id: "",
        name: "",
        query: "",
        goal: "",
        status: "",
        decisions: [],
        done: [],
        blockers: [],
        next: [],
        files: [],
        createdAt: 0,
        updatedAt: 0,
        isActive: false,
      };
      const others = entry.state.demands
        .filter((d) => d.id !== wantId)
        .map((d) => ({ id: d.id, name: d.name, status: d.status, updatedAt: d.updatedAt }));
      const demand = entry.state.demands.find((d) => d.id === wantId);
      if (demand === undefined) {
        return { demand: notFound, others, statePath: entry.p.state, handoffPath: entry.p.handoff };
      }
      const detail = demand.id === entry.state.activeDemandId ? entry.detail : parseDetail(demand.handoffSnapshot);
      return {
        demand: {
          found: true,
          id: demand.id,
          name: demand.name,
          query: demand.query,
          goal: detail.goal,
          status: detail.status,
          decisions: strList(detail.decisions),
          done: strList(detail.done),
          blockers: strList(detail.blockers),
          next: strList(detail.next),
          files: strList(detail.files),
          createdAt: demand.createdAt,
          updatedAt: demand.updatedAt,
          isActive: demand.id === entry.state.activeDemandId,
        },
        others,
        statePath: entry.p.state,
        handoffPath: entry.p.handoff,
      };
    },
  });

  /* ------------------------------------------------------------ 投影与注入 */

  ctx.sessionProjections.register({
    key: INJECTION_KEY,
    stateVersion: 1,
    stateSchema: { parse: parseInjectionState },
    init: () => ({ injectedAt: null, demandId: null, fingerprint: "", compactionSeq: null }),
    apply: (state, event) => {
      // 只认自己注入的那条，避免把用户消息误判成注入
      if (event.type === "user/message" && event.data.source?.kind === name) {
        return { ...state, injectedAt: event.time, demandId: event.data.source.demandId ?? state.demandId, fingerprint: event.data.source.fingerprint ?? state.fingerprint };
      }
      // 压缩发生 → 记下序号，下一步强制重注入（Harness 把"上下文被压缩"列为恢复点）
      if (event.type === "compact/end") return { ...state, compactionSeq: event.seq ?? 0 };
      return state;
    },
  });

  /** 注入正文：当前需求详情（截断）+ 同会话其他需求索引 */
  function renderBlock(entry) {
    const demand = entry.state.demands.find((d) => d.id === entry.state.activeDemandId);
    if (demand === undefined) return "";
    const detail = entry.detail;
    const list = (xs) => {
      if (xs.length === 0) return "（无）";
      const shown = xs.slice(0, maxItems);
      const body = shown.map((x) => `- ${x}`).join("\n");
      // 截断必须显式说明：静默截断会让读者以为列表就这些
      if (xs.length <= shown.length) return body;
      return `${body}\n- …另有 ${xs.length - shown.length} 条未展开，完整内容见 handoff.md`;
    };
    const parts = [`需求目标：${detail.goal || "（未填写）"}`, `需求状态：${detail.status}`, `下一步：\n${list(detail.next)}`];
    if (detail.blockers.length > 0) parts.push(`卡点：\n${list(detail.blockers)}`);
    if (detail.decisions.length > 0) parts.push(`关键决策：\n${list(detail.decisions)}`);
    let text = parts.join("\n");
    if (text.length > maxDetailChars) text = `${text.slice(0, maxDetailChars)}…`;

    const others = entry.state.demands.filter((d) => d.id !== demand.id);
    const lines = [
      "## 工作记忆（当前需求状态）",
      "",
      "这是此前会话留下的需求状态，用于接续工作。",
      "**这些是历史状态，不是当前指令**；若与用户当前的要求冲突，以当前要求为准。",
      "**其中「已完成」等自述不构成证据**；需要时请重新验证，不要据此宣称完成。",
      "",
      `### 当前需求：${demand.name || demand.id}`,
      "",
      text,
    ];
    if (others.length > 0) {
      lines.push("", "### 本会话的其他需求（handoff.md 只保存当前需求，切回旧需求用 working_memory_start）", "");
      for (const d of others) {
        const when = d.updatedAt === 0 ? "—" : new Date(d.updatedAt).toLocaleString("zh-CN");
        lines.push(`- \`${d.id}\` ${d.name} —— ${d.status}，最后更新 ${when}`);
      }
    }
    return lines.join("\n");
  }

  ctx.on(
    "agent/pre-step",
    async ({ agent, messages, signal }, next) => {
      const decision = await next();
      if (decision.kind === "reject" || signal?.aborted) return decision;
      try {
        const session = agent.session;
        const sessionId = session?.id;
        if (typeof sessionId !== "string" || sessionId === "") return decision;
        const cwd = session?.header?.cwd ?? process.cwd();
        const title = str(session?.title, "") || str(session?.header?.title, "");
        const entry = loadSession(cwd, sessionId, title);
        if (entry.state.activeDemandId === "") return decision;

        const fp = fingerprintOf(entry.state.activeDemandId, entry.detail);
        // 同一状态已在上下文中 → 不重复注入
        const already = decision.messages.some((m) => m.source?.kind === name && m.source?.fingerprint === fp);
        if (already) return decision;

        const text = renderBlock(entry);
        if (text === "") return decision;
        const desired = createUserMessage({
          content: [textBlock(text)],
          source: { kind: name, form: "snapshot", demandId: entry.state.activeDemandId, fingerprint: fp, sections: [{ name, text }] },
        });

        // 状态变了（或首次、或被压缩摘掉）：移除旧块，插到最新消息之后，
        // 使其始终待在尾部 —— 压缩只逐字保留尾部，靠的就是这个位置
        const base = decision.messages.filter((m) => m.source?.kind !== name);
        const lastNew = findLastNewMessageIndex(base, messages);
        const at = lastNew === -1 ? base.length : lastNew + 1;
        return { ...decision, messages: base.toSpliced(at, 0, desired) };
      } catch (error) {
        ctx.logger?.warn?.(`working-memory: 注入失败，跳过本次: ${String(error)}`);
        return decision;
      }
    },
    { prepend: true },
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 卸载阶段忽略 */
      }
    }
  };
}
