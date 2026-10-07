/**
 * 跨机器可移植的路径解析。
 *
 * 为什么需要它：本仓库要在多台机器上使用，工作区绝对路径刻意保持一致，
 * 但「用户目录」因机器而异（用户名不同、盘符可能不同）。因此脚本里
 * 不得再出现写死的用户名或盘符 —— 全部从这里推导。
 *
 * 优先级与 DSH 平台一致（@deepseek-ai/dsh-home-paths::resolveDshHome）：
 *   显式配置 > $DSH_HOME > ~/.dsh
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

/** 本仓库根目录 = 本文件所在目录。随工作区移动，不含任何机器相关信息。 */
export const WORKSPACE_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析 DSH home。空或纯空白的 $DSH_HOME 视为未设置（与平台一致），
 * 避免把 home 解析到当前工作目录。
 * @param env - 环境变量映射。
 * @returns 绝对路径的 DSH home。
 */
export function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME;
  const base = raw !== undefined && raw.trim().length > 0 ? raw : path.join(os.homedir(), ".dsh");
  return path.resolve(base);
}

/** profiles 目录：`$DSH_HOME/profiles`。 */
export function resolveProfilesDir(env = process.env) {
  return path.join(resolveDshHome(env), "profiles");
}

/**
 * 解析命令行：`--profile <名>` / `--profile=<名>`；
 * 其余第一个非选项参数作为备份备注（stamp）。
 * 默认 stamp 为 "manual"，避免旧写法 `process.argv[2]` 把 `--profile` 当成备注。
 * @param argv - 参数数组（不含 node 与脚本名）。
 * @returns `{ profile, stamp }`。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  let profile;
  let stamp;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") profile = argv[i + 1];
    else if (arg.startsWith("--profile=")) profile = arg.slice("--profile=".length);
    else if (!arg.startsWith("-") && stamp === undefined) stamp = arg;
  }
  return { profile, stamp: stamp ?? "manual" };
}

/** profile 由 DSH 自己在首次启动时创建，其标志是 profile 目录下有 package.json。 */
function hasManifest(dir) {
  return fs.existsSync(path.join(dir, "package.json"));
}

/**
 * 解析要部署到的 profile。
 *
 * 顺序：`--profile` / `$DSH_PROFILE` 指定 > profiles 下唯一者 > `desktop`。
 * 本函数**只读不建**：profile 目录必须由 DSH 自己 `initProfile()` 创建，
 * 否则会造出一个 DSH 不认的目录，故障表现为插件静默不挂载。
 * @returns `{ dir, name }`。
 * @throws 当 profiles 目录不存在、没有任何可用 profile、或指定名不存在时，附带可操作提示。
 */
export function resolveProfileTarget({ profile, env = process.env } = {}) {
  const profilesDir = resolveProfilesDir(env);
  const explicit = profile ?? (env.DSH_PROFILE?.trim() ? env.DSH_PROFILE.trim() : undefined);

  if (!fs.existsSync(profilesDir)) {
    throw new Error(
      `找不到 profiles 目录：${profilesDir}\n` +
        `  → 请先在这台机器上启动一次 DSH（它会自己创建 profile），再运行本脚本。\n` +
        `  → 若 DSH 数据不在默认位置，请先设置环境变量 DSH_HOME。`,
    );
  }

  const available = fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && hasManifest(path.join(profilesDir, e.name)))
    .map((e) => e.name);

  if (available.length === 0) {
    throw new Error(
      `profiles 目录里还没有任何 profile：${profilesDir}\n` +
        `  → 请先在这台机器上启动一次 DSH（桌面端会创建 desktop），再运行本脚本。`,
    );
  }

  if (explicit !== undefined) {
    if (!available.includes(explicit)) {
      throw new Error(`指定的 profile "${explicit}" 不存在或没有 package.json。可用：${available.join(", ")}`);
    }
    return { dir: path.join(profilesDir, explicit), name: explicit };
  }

  if (available.length === 1) return { dir: path.join(profilesDir, available[0]), name: available[0] };
  if (available.includes("desktop")) return { dir: path.join(profilesDir, "desktop"), name: "desktop" };

  throw new Error(
    `profiles 目录下有多个 profile，无法自动选择：${available.join(", ")}\n` + `  → 请加 --profile <名称> 指定。`,
  );
}

/** 只要目录路径的便捷封装。 */
export function resolveProfileDir(args) {
  return resolveProfileTarget(args).dir;
}

/**
 * 载入仓库自带的 js-yaml（校验 patch 文件用）。
 * 路径相对本仓库根目录，故可随工作区整体移动；缺失时返回 null，由调用方降级或报错。
 * @returns js-yaml 模块，或 null。
 */
export function loadYaml() {
  const file = path.join(WORKSPACE_ROOT, "yaml-check", "node_modules", "js-yaml", "dist", "js-yaml.cjs.js");
  return fs.existsSync(file) ? require_(file) : null;
}
