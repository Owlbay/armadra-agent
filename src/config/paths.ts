/**
 * 目录解析（设计 §10.1、§11.1 第 5 步）。[B5]
 *
 * - 用户级配置目录：`AMA_CONFIG_DIR` > Windows `%APPDATA%\ama` > `$XDG_CONFIG_HOME/ama` > `~/.config/ama`。
 * - 数据目录：`AMA_DATA_DIR` > Windows `%LOCALAPPDATA%\ama` > `$XDG_DATA_HOME/ama` > `~/.local/share/ama`。
 * - 会话目录：`--session-dir` > profile.sessionDir > `<dataDir>/sessions`。
 */

import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StartupError } from "../errors.js";
import { msg } from "../i18n/index.js";
import type { ResolvedPaths } from "../cli/runtime.js";

/** 与 cli/exit-codes.ts 的 Config 相同；config 层不反向依赖 cli 的值。 */
const EXIT_CONFIG = 3;

export const CONFIG_FILE = "config.json";
export const AUTH_FILE = "auth.json";
export const HOOKS_FILE = "hooks.json";
export const TRUST_FILE = "trust.json";
export const KEYBINDINGS_FILE = "keybindings.json";
/** 项目级目录名（`<cwd>/.ama/`）。 */
export const PROJECT_DIR = ".ama";

export interface PathEnv {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

function envOf(options: PathEnv): Readonly<Record<string, string | undefined>> {
  return options.env ?? process.env;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function homeOf(options: PathEnv): string {
  const env = envOf(options);
  return options.home ?? nonEmpty(env["HOME"]) ?? nonEmpty(env["USERPROFILE"]) ?? homedir();
}

/** 展开开头的 `~`。 */
export function expandHome(path: string, options: PathEnv = {}): string {
  if (path === "~") return homeOf(options);
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homeOf(options), path.slice(2));
  return path;
}

export function resolveConfigDir(options: PathEnv = {}): string {
  const env = envOf(options);
  const explicit = nonEmpty(env["AMA_CONFIG_DIR"]);
  if (explicit !== undefined) return resolve(expandHome(explicit, options));
  if ((options.platform ?? process.platform) === "win32") {
    const appData = nonEmpty(env["APPDATA"]);
    if (appData !== undefined) return join(appData, "ama");
  }
  const xdg = nonEmpty(env["XDG_CONFIG_HOME"]);
  if (xdg !== undefined && isAbsolute(xdg)) return join(xdg, "ama");
  return join(homeOf(options), ".config", "ama");
}

export function resolveDataDir(options: PathEnv = {}): string {
  const env = envOf(options);
  const explicit = nonEmpty(env["AMA_DATA_DIR"]);
  if (explicit !== undefined) return resolve(expandHome(explicit, options));
  if ((options.platform ?? process.platform) === "win32") {
    const local = nonEmpty(env["LOCALAPPDATA"]);
    if (local !== undefined) return join(local, "ama");
  }
  const xdg = nonEmpty(env["XDG_DATA_HOME"]);
  if (xdg !== undefined && isAbsolute(xdg)) return join(xdg, "ama");
  return join(homeOf(options), ".local", "share", "ama");
}

export interface ResolvePathsInput extends PathEnv {
  cwd: string;
  /** `--session-dir`（相对 cwd）。 */
  sessionDirFlag?: string | undefined;
  /** profile.sessionDir（已校验为绝对路径）。 */
  profileSessionDir?: string | undefined;
}

export function resolvePaths(input: ResolvePathsInput): ResolvedPaths {
  const configDir = resolveConfigDir(input);
  const dataDir = resolveDataDir(input);
  const cwd = resolve(input.cwd);
  let sessionDir: string;
  if (input.sessionDirFlag !== undefined) {
    sessionDir = resolve(cwd, expandHome(input.sessionDirFlag, input));
  } else if (input.profileSessionDir !== undefined) {
    sessionDir = resolve(input.profileSessionDir);
  } else {
    sessionDir = join(dataDir, "sessions");
  }
  return { configDir, dataDir, sessionDir, cwd };
}

/** 建目录（0700）并确认可写；失败抛 StartupError（退出码 3）。 */
export function ensureDir(dir: string, label: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!statSync(dir).isDirectory()) throw new Error(msg().config.paths.notDirectory);
    accessSync(dir, constants.W_OK);
  } catch (error) {
    throw new StartupError(
      "config_invalid",
      msg().config.paths.notWritable(
        label,
        dir,
        error instanceof Error ? error.message : String(error),
      ),
      EXIT_CONFIG,
      { cause: error },
    );
  }
}

/** 第 5 步：建 configDir / dataDir / sessionDir。 */
export function ensurePaths(paths: ResolvedPaths): void {
  ensureDir(paths.configDir, msg().config.paths.configDir);
  ensureDir(paths.dataDir, msg().config.paths.dataDir);
  ensureDir(paths.sessionDir, msg().config.paths.sessionDir);
}

export function userFile(paths: Pick<ResolvedPaths, "configDir">, name: string): string {
  return join(paths.configDir, name);
}

export function projectFile(cwd: string, name: string): string {
  return join(cwd, PROJECT_DIR, name);
}
