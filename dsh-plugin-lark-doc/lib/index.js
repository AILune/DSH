/**
 * DSH 插件：飞书云文档（Docx）读写工具。
 *
 * 把 lark-cli 封装成 5 个带 schema 校验的一等工具，注册进 DSH 的工具注册表，
 * 取代原先"靠 skill 说明 + 手工拼 shell 命令"的做法。
 *
 * ## 为什么这个插件没有任何外部 import
 *
 * DSH 的运行时包（@deepseek-ai/*）被打包在 app.asar 内，磁盘上没有裸包可供
 * 插件解析。DSH 的运行时解析器（dsh-app-boot `routeLinked`）只对"插件 package.json
 * 里声明过的 peer"做拦截转发，因此依赖这个机制虽有理论依据，却无法在挂载前
 * 本地验证，且一旦解析失败整个插件都不会加载。
 *
 * 与其赌那层拦截，这里把工具定义所需的 JSON Schema 直接内联：
 * `ctx.tools.register()` 接受的本来就是普通 JSON Schema 对象
 * （见 dsh-tools `register()`：只校验 output.schema 与 output.render），
 * 并不要求经过 `defineTool()` 构造。
 *
 * 结果是本插件对外部模块依赖为 0，只用 Node 内置能力，加载必然成功。
 * 内联的 schema 由 `defineTool` 版本导出（compiled-schemas.json），
 * 不是手写近似值。
 *
 * 设计要点：
 *  - 内容参数一律先写临时文件，再用 `@file` 传给 lark-cli，彻底避开命令行转义。
 *  - lark-cli 的响应是 JSON；同时兼容纯文本输出与 _notice 提示。
 *  - 所有失败都抛出带 lark-cli 原始错误的异常，由 DSH 统一转成 isError 结果。
 *
 * @module dsh-plugin-lark-doc
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Cordis 插件名。 */
export const name = "lark-doc";

/** 依赖的工具注册表服务。 */
export const inject = ["tools"];

/** lark-cli 可执行文件的候选位置。 */
const DEFAULT_BIN_CANDIDATES = [
  "C:\\Users\\85448\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe",
  join(
    process.env.APPDATA ?? "",
    "npm",
    "node_modules",
    "@larksuite",
    "cli",
    "bin",
    "lark-cli.exe",
  ),
];

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

/**
 * 依据 JSON Schema 校验调用参数，返回违规描述数组。
 * 只实现本插件用到的关键字（type / required / enum），够用且无依赖。
 */
function validateArgs(schema, args) {
  const violations = [];
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return [`arguments must be an object`];
  }
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const key of required) {
    if (!Object.hasOwn(args, key) || args[key] === undefined) {
      violations.push(`missing required property "${key}"`);
    }
  }

  const typeMatches = (value, type) => {
    switch (type) {
      case "string":
        return typeof value === "string";
      case "integer":
        return Number.isInteger(value);
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return value !== null && typeof value === "object" && !Array.isArray(value);
      default:
        return true;
    }
  };

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const spec = properties[key];
    if (spec === undefined) {
      violations.push(`unknown property "${key}"`);
      continue;
    }
    if (spec.type && !typeMatches(value, spec.type)) {
      violations.push(`"${key}" must be of type ${spec.type}`);
      continue;
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      violations.push(`"${key}" must be one of ${JSON.stringify(spec.enum)}`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// lark-cli 调用
// ---------------------------------------------------------------------------

/** 解析出可用的 lark-cli 路径。 */
function resolveBinary(configured) {
  if (configured && String(configured).trim() !== "") {
    if (!existsSync(configured)) {
      throw new Error(`lark-doc: 配置的 binaryPath 不存在: ${configured}`);
    }
    return configured;
  }
  for (const candidate of DEFAULT_BIN_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    "lark-doc: 找不到 lark-cli。请安装（npm install -g @larksuite/cli）或通过插件 config.binaryPath 指定路径。",
  );
}

/** 把 lark-cli 的原始输出解析成 JSON；非 JSON 时返回 null。 */
function parseCliOutput(stdout) {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 lark-cli 响应里提取可读错误信息。 */
function cliError(parsed, raw, code) {
  if (parsed && typeof parsed === "object") {
    const err = parsed.error;
    if (err && typeof err === "object") {
      const parts = [err.message, err.hint].filter(Boolean);
      if (parts.length > 0) return parts.join(" — ");
    }
    if (typeof parsed.message === "string" && parsed.message !== "") {
      return parsed.message;
    }
    return JSON.stringify(parsed).slice(0, 800);
  }
  const trimmed = (raw ?? "").trim();
  if (trimmed !== "") return trimmed.slice(0, 800);
  return `lark-cli 退出码 ${code}`;
}

/**
 * 运行一次 lark-cli。
 * @returns 解析后的响应对象
 */
function runCli(bin, argv, timeoutMs, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, argv, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      fn(payload);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(rejectPromise, new Error(`lark-doc: lark-cli 调用超时（${timeoutMs} ms）`));
    }, timeoutMs);

    const onAbort = signal
      ? () => {
          child.kill();
          finish(rejectPromise, new Error("lark-doc: 调用被取消"));
        }
      : null;
    if (onAbort && signal) signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(rejectPromise, new Error(`lark-doc: 无法启动 lark-cli — ${error.message}`));
    });
    child.on("close", (code) => {
      const parsed = parseCliOutput(stdout);
      if (code !== 0 || (parsed && parsed.ok === false)) {
        finish(rejectPromise, new Error(cliError(parsed, stderr || stdout, code)));
        return;
      }
      finish(resolvePromise, parsed ?? { ok: true });
    });
  });
}

/** 在临时目录里准备一个内容文件，返回其路径。 */
async function withTempContent(content) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-lark-"));
  const file = join(dir, "content.txt");
  await writeFile(file, content, "utf8");
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 断言响应里存在期望的数据结构。 */
function expectData(response, what) {
  const data = response?.data;
  if (!data || typeof data !== "object") {
    throw new Error(
      `lark-doc: ${what} 未返回 data 字段。原始响应: ${JSON.stringify(response).slice(0, 400)}`,
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// 工具定义（schema 由 defineTool 版本导出，见 compiled-schemas.json）
// ---------------------------------------------------------------------------

/** 构造一个注册用的工具定义，自动附加参数校验。 */
function tool(definition) {
  const { parameters, ...rest } = definition;
  return {
    ...rest,
    parameters,
    async execute(args, exec) {
      const violations = validateArgs(parameters, args);
      if (violations.length > 0) {
        const error = new Error(
          `invalid arguments: ${violations.join("; ")}`,
        );
        error.name = "ToolArgsError";
        throw error;
      }
      return definition.execute(args, exec);
    },
  };
}

/** 把若干行拼成一个文本块。 */
const textBlock = (lines) => [{ type: "text", text: lines.filter(Boolean).join("\n") }];

/**
 * 去掉搜索接口返回的高亮标记。
 * 飞书用 <h>/<hb> 包住命中词（以及 <b> 等强调），展示时应还原为纯文本。
 */
function stripHighlight(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<\/?h[b]?>/g, "")
    .replace(/<\/?b>/g, "")
    .trim();
}

/** 生成 5 个飞书文档工具的完整定义。 */
function defineTools({ binary, identity, timeoutMs }) {
  /** 统一调用入口，自动附加 --as。 */
  const cli = (argv, signal) => runCli(binary, [...argv, "--as", identity], timeoutMs, signal);

  return [
    // ------------------------------------------------------------- 创建文档
    tool({
      name: "lark_doc_create",
      description:
        "在飞书创建一篇新文档（Docx）。适用于把 Markdown 或结构化内容写成一篇文章、报告、纪要。返回新文档的 document_id 与可访问 URL。若目标是已存在的文档，请改用 lark_doc_read 或 lark_doc_replace。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "文档标题。" },
          content: {
            type: "string",
            description:
              "文档正文。必须是单行可传的字符串；多行内容由本工具自动经临时文件传递，无需自行转义。格式须与 doc_format 一致：doc_format=xml 时用 DocxXML，doc_format=markdown 时用 Markdown。",
          },
          doc_format: {
            type: "string",
            description:
              "正文格式。xml（默认）支持更丰富的 DocxXML 块；markdown 走纯 Markdown 导入。两者写法不通用，务必与 content 匹配。",
            enum: ["markdown", "xml"],
          },
          parent_position: {
            type: "string",
            description: '创建位置，例如 "my_library" 表示我的空间。与 parent_token 互斥。',
          },
          parent_token: {
            type: "string",
            description: "父文件夹 token 或知识库节点 token。与 parent_position 互斥。",
          },
        },
        required: ["title", "content"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            document_id: { type: "string" },
            url: { type: "string" },
            revision_id: { type: "integer" },
          },
          required: ["document_id", "url", "revision_id"],
        },
        render: (_args, value) =>
          textBlock([
            `已创建飞书文档。`,
            `document_id: ${value.document_id}`,
            `revision_id: ${value.revision_id}`,
            `URL: ${value.url}`,
          ]),
      },
      timeoutMs,
      async execute(args, exec) {
        const { file, cleanup } = await withTempContent(args.content);
        try {
          const argv = [
            "docs",
            "+create",
            "--title",
            args.title,
            "--content",
            `@${file}`,
            "--doc-format",
            args.doc_format ?? "markdown",
          ];
          if (args.parent_token) argv.push("--parent-token", args.parent_token);
          else if (args.parent_position) argv.push("--parent-position", args.parent_position);

          const data = expectData(await cli(argv, exec.signal), "创建文档");
          const documentId = data.document?.document_id ?? data.document_id ?? "";
          const url = data.document?.url ?? data.url ?? "";
          const revisionId = data.document?.revision_id ?? data.revision_id ?? 0;
          for (const [label, value] of [["document_id", documentId], ["url", url]]) {
            if (typeof value !== "string" || value === "") {
              throw new Error(
                `lark-doc: 创建响应缺少 ${label}。原始 data: ${JSON.stringify(data).slice(0, 400)}`,
              );
            }
          }
          return {
            document_id: documentId,
            url,
            revision_id: Number(revisionId) || 0,
          };
        } finally {
          await cleanup();
        }
      },
    }),

    // ------------------------------------------------------------- 读取文档
    tool({
      name: "lark_doc_read",
      description:
        "读取一篇飞书文档（Docx）的内容。接受文档 URL 或 token。注意：若链接指向的是电子表格或多维表格（Base），本工具会失败，应改用飞书 Base 相关工具。",
      parameters: {
        type: "object",
        properties: {
          doc: { type: "string", description: "文档 URL 或 token。" },
          doc_format: {
            type: "string",
            description:
              "返回格式。xml（默认）保留 DocxXML 结构；markdown 返回纯 Markdown，更易阅读；im-markdown 会把残留的 DocxXML 片段降级为适合 IM 发送的形式。",
            enum: ["markdown", "xml", "im-markdown"],
          },
        },
        required: ["doc"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            document_id: { type: "string" },
            revision_id: { type: "integer" },
            content: { type: "string" },
          },
          required: ["document_id", "revision_id", "content"],
        },
        render: (_args, value) =>
          textBlock([
            `document_id: ${value.document_id}  revision_id: ${value.revision_id}`,
            "",
            value.content,
          ]),
      },
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const data = expectData(
          await cli(
            [
              "docs",
              "+fetch",
              "--doc",
              args.doc,
              "--doc-format",
              args.doc_format ?? "markdown",
            ],
            exec.signal,
          ),
          "读取文档",
        );
        const document = data.document ?? data;
        if (typeof document.content !== "string") {
          throw new Error(
            `lark-doc: 读取响应缺少 content。若该链接指向的是 sheet/bitable，请改用 Base 工具。原始 data: ${JSON.stringify(data).slice(0, 400)}`,
          );
        }
        return {
          document_id: String(document.document_id ?? ""),
          revision_id: Number(document.revision_id) || 0,
          content: document.content,
        };
      },
    }),

    // ------------------------------------------------------------- 替换文本
    tool({
      name: "lark_doc_replace",
      description:
        "在飞书文档中查找并替换一段文本（全局 str_replace）。适用于改错字、更新某个数值或措辞。不支持替换图片等资源块；涉及整段重写或跨 block 改动时请用 lark_doc_insert 或其它指令。",
      parameters: {
        type: "object",
        properties: {
          doc: { type: "string", description: "文档 URL 或 token。" },
          pattern: {
            type: "string",
            description: "要查找的原文（不要用于多行或整段）。",
          },
          content: {
            type: "string",
            description: "替换后的文本；传空字符串表示删除该文本。",
          },
        },
        required: ["doc", "pattern", "content"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            revision_id: { type: "integer" },
            result: { type: "string" },
            url: { type: "string" },
          },
          required: ["revision_id", "result", "url"],
        },
        render: (_args, value) =>
          textBlock([
            `替换完成（result=${value.result}，revision_id=${value.revision_id}）`,
            value.url ? `URL: ${value.url}` : "",
          ]),
      },
      timeoutMs,
      async execute(args, exec) {
        const data = expectData(
          await cli(
            [
              "docs",
              "+update",
              "--doc",
              args.doc,
              "--command",
              "str_replace",
              "--pattern",
              args.pattern,
              "--content",
              args.content,
            ],
            exec.signal,
          ),
          "替换文本",
        );
        const document = data.document ?? {};
        return {
          revision_id: Number(document.revision_id) || 0,
          result: String(data.result ?? "success"),
          url: String(document.url ?? ""),
        };
      },
    }),

    // ------------------------------------------------------------- 插入内容
    tool({
      name: "lark_doc_insert",
      description:
        "在飞书文档中某个位置插入内容块。默认追加到文档末尾（anchor 传 -1）。可用于新增章节、补写段落、插入列表。content 使用飞书 DocxXML（如 <h2>标题</h2><p>正文</p>）。",
      parameters: {
        type: "object",
        properties: {
          doc: { type: "string", description: "文档 URL 或 token。" },
          content: {
            type: "string",
            description:
              "要插入的 DocxXML 内容块，例如 <h2>章节</h2><ul><li>条目</li></ul>。",
          },
          anchor: {
            type: "string",
            description: '目标 block ID；" -1" 表示文档末尾,"0" 表示开头。默认 -1。',
          },
        },
        required: ["doc", "content"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            revision_id: { type: "integer" },
            result: { type: "string" },
            warnings: { type: "array", items: { type: "string" } },
            new_blocks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  block_id: { type: "string" },
                  block_type: { type: "string" },
                },
                required: ["block_id", "block_type"],
              },
            },
          },
          required: ["revision_id", "result", "warnings", "new_blocks"],
        },
        render: (_args, value) =>
          textBlock([
            `插入完成（result=${value.result}，revision_id=${value.revision_id}）`,
            // 飞书对 block_insert_after 通常不返回 new_blocks；
            // 此时以 revision_id 递增作为成功凭据，不要误报"新增 0 个块"。
            value.new_blocks.length > 0
              ? `新增 ${value.new_blocks.length} 个块：`
              : "（飞书未返回新块明细，以 revision_id 递增为成功凭据）",
            ...value.new_blocks.map((b) => `  ${b.block_type} ${b.block_id}`),
            ...value.warnings.map((w) => `  ⚠️ ${w}`),
          ]),
      },
      timeoutMs,
      async execute(args, exec) {
        const { file, cleanup } = await withTempContent(args.content);
        try {
          const data = expectData(
            await cli(
              [
                "docs",
                "+update",
                "--doc",
                args.doc,
                "--command",
                "block_insert_after",
                "--block-id",
                (args.anchor ?? "-1").trim(),
                "--content",
                `@${file}`,
              ],
              exec.signal,
            ),
            "插入内容",
          );
          const document = data.document ?? {};
          const newBlocks = Array.isArray(document.new_blocks) ? document.new_blocks : [];
          return {
            revision_id: Number(document.revision_id) || 0,
            result: String(data.result ?? "success"),
            warnings: (Array.isArray(data.warnings) ? data.warnings : []).map(String),
            new_blocks: newBlocks.map((b) => ({
              block_id: String(b.block_id ?? ""),
              block_type: String(b.block_type ?? "unknown"),
            })),
          };
        } finally {
          await cleanup();
        }
      },
    }),

    // ------------------------------------------------------------- 搜索文档
    tool({
      name: "lark_doc_search",
      description:
        "在飞书云空间中按关键词搜索文档（含云空间与知识库），用来定位一篇文档的 URL/token。适用于用户只给了文档标题而没给链接的情况。返回的 url 可能是 /docx/ 或 /wiki/ 形式，两者都可直接用于 lark_doc_read。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "搜索关键词，最多 30 个字符（CJK 按 1 计）。传空字符串可只按筛选条件浏览。",
          },
          page_size: {
            type: "integer",
            description: "返回条数，1-20，默认 15。",
          },
          mine: {
            type: "boolean",
            description: "仅搜索「我拥有」的文档（owner 语义，非原始创建者）。",
          },
          only_title: {
            type: "boolean",
            description: "仅匹配标题，不匹配正文。",
          },
          doc_types: {
            type: "string",
            description:
              "逗号分隔的类型过滤：doc,sheet,bitable,mindnote,file,wiki,docx,folder,catalog,slides,shortcut。",
          },
        },
        required: ["query"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            total: { type: "integer" },
            has_more: { type: "boolean" },
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  title: { type: "string" },
                  url: { type: "string" },
                  token: { type: "string" },
                  type: { type: "string" },
                  owner: { type: "string" },
                  updated_at: { type: "string" },
                  summary: { type: "string" },
                },
                required: ["title", "url", "token", "type", "owner", "updated_at", "summary"],
              },
            },
          },
          required: ["total", "has_more", "items"],
        },
        render: (_args, value) =>
          value.items.length === 0
            ? textBlock(["未找到匹配的文档。"])
            : textBlock([
                `找到 ${value.items.length} 条（total=${value.total}${value.has_more ? "，还有更多" : ""}）：`,
                ...value.items.flatMap((it) => {
                  const lines = [
                    `  [${it.type}] ${it.title}`,
                    `      归属: ${it.owner}   更新: ${it.updated_at}`,
                    `      ${it.url}`,
                  ];
                  if (it.summary) lines.push(`      摘要: ${it.summary}`);
                  return lines;
                }),
              ]),
      },
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        // 服务端会把越界值静默钳制（0→15，99→20），这里先钳好，
        // 让实际请求与声明一致，也避免调用方误以为拿到了 99 条。
        const requested = Number.isInteger(args.page_size) ? args.page_size : 15;
        const pageSize = Math.min(20, Math.max(1, requested));

        const argv = [
          "drive",
          "+search",
          "--query",
          args.query,
          "--page-size",
          String(pageSize),
        ];
        if (args.mine === true) argv.push("--mine");
        if (args.only_title === true) argv.push("--only-title");
        if (typeof args.doc_types === "string" && args.doc_types !== "") {
          argv.push("--doc-types", args.doc_types);
        }

        const data = expectData(await cli(argv, exec.signal), "搜索文档");
        const results = Array.isArray(data.results)
          ? data.results
          : Array.isArray(data.items)
            ? data.items
            : [];

        return {
          total: Number(data.total ?? results.length) || 0,
          has_more: data.has_more === true,
          items: results.map((entry) => {
            const meta = entry.result_meta ?? {};
            return {
              title: stripHighlight(entry.title_highlighted ?? meta.title ?? "(无标题)"),
              url: String(meta.url ?? entry.url ?? ""),
              token: String(meta.token ?? entry.token ?? ""),
              type: String(meta.doc_types ?? entry.entity_type ?? "unknown"),
              owner: String(meta.owner_name ?? meta.edit_user_name ?? ""),
              updated_at: String(meta.update_time_iso ?? ""),
              summary: stripHighlight(entry.summary_highlighted ?? ""),
            };
          }),
        };
      },
    }),
  ];
}

/**
 * 注册全部飞书文档工具。
 * @param ctx Cordis 上下文（需要 tools 服务）
 * @param config 插件配置 { binaryPath?, identity?, timeoutMs? }
 */
export function apply(ctx, config = {}) {
  const binary = resolveBinary(config.binaryPath ?? "");
  const identity = config.identity ?? "user";
  const timeoutMs =
    Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const disposers = defineTools({ binary, identity, timeoutMs }).map((definition) =>
    ctx.tools.register(definition),
  );

  ctx.logger?.info?.(
    "lark-doc: 已注册 %d 个飞书文档工具（binary=%s, identity=%s）",
    disposers.length,
    binary,
    identity,
  );

  // 返回 disposer，让 Cordis 在插件卸载时干净地注销工具。
  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        // 卸载期的注销失败不应影响其它工具
      }
    }
  };
}
