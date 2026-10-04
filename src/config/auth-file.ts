/**
 * auth.json 读写（设计 §3.5 ②③、§10.1）与 `ama auth` 后端。[B5]
 *
 * - 文件权限 0600；读到非 0600（POSIX）→ warning 并照用，doctor 提示。
 * - 写入：同目录临时文件（0600）→ rename，再 chmod 一次兜底。
 * - 本模块只搬运字符串，不解析 `!command` / `$ENV`（那是 ai/providers/auth.ts 的事），
 *   也不把 key 写进任何日志或返回给展示层（`describeAuthFile` 只给来源与形态）。
 */

import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { retryTransientFs } from "./fs-retry.js";
import { dirname, join } from "node:path";
import { loadConfigFile } from "./load.js";
import { AUTH_FILE } from "./paths.js";
import type { AuthFile } from "./types.js";
import { CONFIG_FILE_VERSION, apiKeyEntry } from "./types.js";
import { isOAuthEntry, type ChatGptFlavor } from "./types-w6.js";
import { msg } from "../i18n/index.js";

export function defaultAuthFilePath(configDir: string): string {
  return join(configDir, AUTH_FILE);
}

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface ReadAuthResult {
  path: string;
  exists: boolean;
  file: AuthFile;
  warnings: string[];
  /** POSIX 下的权限位（八进制数），Windows 为 undefined。 */
  mode?: number;
}

/** 当前权限位；文件不存在为 undefined。 */
export function fileMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

export function isModeTooOpen(mode: number | undefined, platform = process.platform): boolean {
  return platform !== "win32" && mode !== undefined && (mode & 0o077) !== 0;
}

/** 读 auth.json；不存在 → 空文件。语法 / 字段错误抛 StartupError（3）。 */
export function readAuthFile(path: string): ReadAuthResult {
  const loaded = loadConfigFile("auth", path);
  if (loaded === undefined) {
    return {
      path,
      exists: false,
      file: { version: CONFIG_FILE_VERSION, providers: {} },
      warnings: [],
    };
  }
  const warnings = [...loaded.warnings];
  const mode = fileMode(path);
  if (isModeTooOpen(mode)) {
    warnings.push(
      msg().config.authFile.modeTooOpen(path, mode?.toString(8).padStart(4, "0") ?? ""),
    );
  }
  const result: ReadAuthResult = { path, exists: true, file: loaded.value, warnings };
  if (mode !== undefined && process.platform !== "win32") result.mode = mode;
  return result;
}

export function writeAuthFile(path: string, file: AuthFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    // Windows：别的 ama 进程正读着 auth.json 时覆盖它会暂时失败
    retryTransientFs(() => renameSync(tmp, path));
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/** `ama auth set`：设置 / 替换一家的 key（保留该条目的 env / baseUrl）。 */
export function setAuthKey(path: string, provider: string, apiKey: string): void {
  const { file } = readAuthFile(path);
  // [W6-C0] 覆盖 OAuth 条目时不带走它的字段
  const previous = apiKeyEntry(file.providers[provider]);
  file.providers[provider] = { ...previous, apiKey };
  writeAuthFile(path, { version: CONFIG_FILE_VERSION, providers: file.providers });
}

/** `ama auth remove`：返回是否删除了条目。 */
export function removeAuthKey(path: string, provider: string): boolean {
  const { file, exists } = readAuthFile(path);
  if (!exists || file.providers[provider] === undefined) return false;
  delete file.providers[provider];
  writeAuthFile(path, { version: CONFIG_FILE_VERSION, providers: file.providers });
  return true;
}

export type AuthValueKind = "literal" | "command" | "env-ref";

/** 只描述 key 的形态，不暴露值。 */
export function classifyKeyValue(value: string): AuthValueKind {
  if (value.startsWith("!")) return "command";
  if (/^\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(value)) return "env-ref";
  return "literal";
}

export interface AuthEntrySummary {
  provider: string;
  /** `oauth`：OAuth 条目（只给 flavor / plan / expiresIn / needsLogin，从不给 token、邮箱、账户 id）。 */
  kind: AuthValueKind | "oauth";
  hasBaseUrl: boolean;
  envNames: string[];
  /** [W6-O] OAuth 条目：登录路径。 */
  flavor?: ChatGptFlavor;
  /** [W6-O] OAuth 条目：计划类型（plus / pro …）。 */
  plan?: string;
  /** [W6-O] OAuth 条目：access token 剩余毫秒（已过期为负；刷新会自动续）。 */
  expiresIn?: number;
  /** [W6-O] OAuth 条目：刷新永久失败，需要重新登录。 */
  needsLogin?: boolean;
}

export function describeAuthFile(file: AuthFile, now: number = Date.now()): AuthEntrySummary[] {
  return Object.entries(file.providers)
    .map(([provider, raw]): AuthEntrySummary => {
      if (isOAuthEntry(raw)) {
        const summary: AuthEntrySummary = {
          provider,
          kind: "oauth",
          hasBaseUrl: false,
          envNames: [],
          flavor: raw.flavor,
          expiresIn: raw.expiresAt - now,
          needsLogin: raw.needsLogin === true,
        };
        if (raw.planType !== undefined) summary.plan = raw.planType;
        return summary;
      }
      const entry = apiKeyEntry(raw);
      if (entry === undefined) return { provider, kind: "oauth", hasBaseUrl: false, envNames: [] };
      return {
        provider,
        kind: classifyKeyValue(entry.apiKey),
        hasBaseUrl: entry.baseUrl !== undefined,
        envNames: Object.keys(entry.env ?? {}).sort(),
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}
