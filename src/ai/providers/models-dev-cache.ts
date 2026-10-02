/**
 * models.dev 缓存（docs/providers.md「模型元数据：models.dev」）。
 *
 * - 缓存文件 `<dataDir>/models-dev.json`：`{ version, url, fetchedAt, etag?, providers }`，providers 是
 *   `trimModelsDev()` 裁剪后的数据（约 2.3 MB，原始约 5 MB）。写入走同目录临时文件 + rename。
 * - **启动不联网**：`loadModelsDevIndex()` 只读缓存（按路径 + mtime 记忆，同一进程只解析一次）。
 * - 联网只在 `ama providers add|refresh`、`ama models discover`、`ama models refresh-catalog` 调
 *   `refreshModelsDev()` 时发生：缓存 24 小时内不重拉（`force` 例外），带 `If-None-Match`；304 只刷新时间；
 *   失败时返回旧缓存与 warning。`AMA_MODELS_DEV_URL` 换数据源。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ModelsDevIndex, trimModelsDev, type ModelsDevData } from "./models-dev.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_URL_ENV = "AMA_MODELS_DEV_URL";
export const MODELS_DEV_FILE = "models-dev.json";
export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
export const MODELS_DEV_TIMEOUT_MS = 30_000;

export interface ModelsDevCacheFile {
  version: 1;
  url: string;
  /** ISO 8601。 */
  fetchedAt: string;
  etag?: string;
  providers: ModelsDevData;
}

export function modelsDevCachePath(dataDir: string): string {
  return join(dataDir, MODELS_DEV_FILE);
}

export function modelsDevUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const custom = env[MODELS_DEV_URL_ENV]?.trim();
  return custom ? custom : MODELS_DEV_URL;
}

/** 读缓存；不存在或损坏返回 undefined（损坏不报错：下次拉取会覆盖）。 */
export function readModelsDevCache(dataDir: string): ModelsDevCacheFile | undefined {
  try {
    const value = JSON.parse(readFileSync(modelsDevCachePath(dataDir), "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const file = value as Partial<ModelsDevCacheFile>;
    if (file.version !== 1 || typeof file.fetchedAt !== "string") return undefined;
    if (typeof file.providers !== "object" || file.providers === null) return undefined;
    return file as ModelsDevCacheFile;
  } catch {
    return undefined;
  }
}

export function writeModelsDevCache(dataDir: string, file: ModelsDevCacheFile): void {
  const path = modelsDevCachePath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file));
  renameSync(tmp, path);
  memo = undefined;
}

let memo: { key: string; index: ModelsDevIndex | undefined } | undefined;

/** 只读缓存构造索引（不联网）；没有缓存返回 undefined。 */
export function loadModelsDevIndex(dataDir: string): ModelsDevIndex | undefined {
  const path = modelsDevCachePath(dataDir);
  let key: string;
  try {
    const stat = statSync(path);
    key = `${path}\0${stat.mtimeMs}\0${stat.size}`;
  } catch {
    return undefined;
  }
  if (memo?.key === key) return memo.index;
  const file = readModelsDevCache(dataDir);
  const index = file !== undefined ? new ModelsDevIndex(file.providers) : undefined;
  memo = { key, index };
  return index;
}

export type RefreshStatus = "fresh" | "updated" | "not-modified" | "stale" | "unavailable";

export interface RefreshResult {
  status: RefreshStatus;
  index?: ModelsDevIndex;
  fetchedAt?: string;
  url: string;
  warning?: string;
}

export interface RefreshOptions {
  dataDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** 忽略 TTL（`ama models refresh-catalog`）。 */
  force?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

/** 按需拉取 models.dev 并更新缓存；失败时回落旧缓存（status `stale`）或无数据（`unavailable`）。 */
export async function refreshModelsDev(options: RefreshOptions): Promise<RefreshResult> {
  const url = modelsDevUrl(options.env);
  const now = options.now ?? Date.now;
  const cached = readModelsDevCache(options.dataDir);
  const cachedIndex = (): ModelsDevIndex | undefined =>
    cached !== undefined ? new ModelsDevIndex(cached.providers) : undefined;
  const age = cached !== undefined ? now() - Date.parse(cached.fetchedAt) : Infinity;
  if (
    cached !== undefined &&
    cached.url === url &&
    !options.force &&
    age >= 0 &&
    age < (options.ttlMs ?? MODELS_DEV_TTL_MS)
  ) {
    return {
      status: "fresh",
      index: cachedIndex() as ModelsDevIndex,
      fetchedAt: cached.fetchedAt,
      url,
    };
  }
  const doFetch = options.fetch ?? fetch;
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cached?.etag !== undefined && cached.url === url) headers["if-none-match"] = cached.etag;
    const response = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? MODELS_DEV_TIMEOUT_MS),
    });
    const fetchedAt = new Date(now()).toISOString();
    if (response.status === 304 && cached !== undefined) {
      writeModelsDevCache(options.dataDir, { ...cached, fetchedAt });
      return { status: "not-modified", index: cachedIndex() as ModelsDevIndex, fetchedAt, url };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const providers = trimModelsDev(await response.json());
    const etag = response.headers.get("etag") ?? undefined;
    writeModelsDevCache(options.dataDir, {
      version: 1,
      url,
      fetchedAt,
      ...(etag !== undefined ? { etag } : {}),
      providers,
    });
    return { status: "updated", index: new ModelsDevIndex(providers), fetchedAt, url };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (cached !== undefined) {
      return {
        status: "stale",
        index: cachedIndex() as ModelsDevIndex,
        fetchedAt: cached.fetchedAt,
        url,
        warning: `models.dev 拉取失败（${reason}），沿用 ${cached.fetchedAt} 的缓存`,
      };
    }
    return {
      status: "unavailable",
      url,
      warning: `models.dev 拉取失败（${reason}），没有缓存可用`,
    };
  }
}

/** 一行状态说明（命令输出用）。 */
export function describeRefresh(result: RefreshResult): string {
  const size = result.index
    ? `${result.index.providerCount} 家供应商、${result.index.modelCount} 个模型`
    : "无数据";
  const text: Record<RefreshStatus, string> = {
    fresh: "缓存未过期",
    updated: "已更新",
    "not-modified": "未变化（304）",
    stale: "拉取失败，用旧缓存",
    unavailable: "不可用",
  };
  return `models.dev：${text[result.status]}（${size}${result.fetchedAt ? `，${result.fetchedAt}` : ""}）`;
}
