/**
 * models.dev 索引 = 内置快照 ⊕ 用户级覆盖（docs/wave5-plan.md §2.2、docs/providers.md「模型元数据」）。
 *
 * - 内置快照随 bundle 携带（models-dev-snapshot.ts），**启动与运行都不联网**。
 * - 覆盖文件 `<dataDir>/models-dev.json`：`{ version: 2, url, fetchedAt, providers }`，只有
 *   `ama models refresh` 会写（`refreshModelsDev()`，显式联网，按快照同一清单裁剪）。存在且
 *   fetchedAt 晚于快照才叠加；同 provider/model 以覆盖为准。旧版（version 1，全量 2 MB 缓存）忽略。
 * - `loadModelsDevIndex()` 按覆盖文件路径 + mtime + 大小记忆，同一进程只解析一次。
 * - `AMA_MODELS_DEV_URL` 换刷新的数据源。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelsDevData, ModelsDevIndex } from "./models-dev.js";
import { ModelsDevIndex as Index } from "./models-dev.js";
import {
  buildSnapshot,
  builtinSnapshot,
  builtinSnapshotIndex,
  diffSnapshots,
  mergeSnapshot,
  snapshotList,
  snapshotMeta,
  type SnapshotDiff,
} from "./models-dev-snapshot.js";
import { msg } from "../../i18n/index.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_URL_ENV = "AMA_MODELS_DEV_URL";
export const MODELS_DEV_FILE = "models-dev.json";
export const MODELS_DEV_TIMEOUT_MS = 60_000;

export interface ModelsDevCacheFile {
  version: 2;
  url: string;
  /** ISO 8601。 */
  fetchedAt: string;
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

/** 读覆盖文件；不存在、旧版或损坏返回 undefined（损坏不报错：下次 refresh 会覆盖）。 */
export function readModelsDevCache(dataDir: string): ModelsDevCacheFile | undefined {
  try {
    const value = JSON.parse(readFileSync(modelsDevCachePath(dataDir), "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const file = value as Partial<ModelsDevCacheFile>;
    if (file.version !== 2 || typeof file.fetchedAt !== "string") return undefined;
    if (Number.isNaN(Date.parse(file.fetchedAt))) return undefined;
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

/** 覆盖文件是否生效：fetchedAt 晚于内置快照。 */
export function overrideApplies(file: ModelsDevCacheFile): boolean {
  return Date.parse(file.fetchedAt) > Date.parse(snapshotMeta().fetchedAt);
}

let memo: { key: string; index: ModelsDevIndex } | undefined;

/** 快照 ⊕ 覆盖（零网络；没有覆盖文件时只做一次 stat）。 */
export function loadModelsDevIndex(dataDir: string): ModelsDevIndex {
  const path = modelsDevCachePath(dataDir);
  let key: string;
  try {
    const stat = statSync(path);
    key = `${path}\0${stat.mtimeMs}\0${stat.size}`;
  } catch {
    return builtinSnapshotIndex();
  }
  if (memo?.key === key) return memo.index;
  const file = readModelsDevCache(dataDir);
  const index =
    file !== undefined && overrideApplies(file)
      ? new Index(mergeSnapshot(builtinSnapshot(), file.providers))
      : builtinSnapshotIndex();
  memo = { key, index };
  return index;
}

/** 当前索引的来源说明（`providers add` / `models discover` 输出用）。 */
export function describeModelsDev(dataDir: string): string {
  const index = loadModelsDevIndex(dataDir);
  const file = readModelsDevCache(dataDir);
  const m = msg().errors.models;
  const via =
    file !== undefined && overrideApplies(file)
      ? m.viaRefresh(snapshotMeta().fetchedAt, file.fetchedAt)
      : m.viaSnapshot(snapshotMeta().fetchedAt);
  return m.describe(via, index.providerCount, index.modelCount);
}

export type RefreshStatus = "updated" | "unchanged" | "failed";

export interface RefreshResult {
  status: RefreshStatus;
  url: string;
  fetchedAt?: string;
  /** 与刷新前的索引（快照 ⊕ 旧覆盖）相比。 */
  diff?: SnapshotDiff;
  index: ModelsDevIndex;
  warning?: string;
}

export interface RefreshOptions {
  dataDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** 只刷新这几家（须在快照清单里）。 */
  providers?: readonly string[];
  timeoutMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

/** 显式联网刷新（只被 `ama models refresh` 调用）：拉 api.json、按清单裁剪、写用户级覆盖。 */
export async function refreshModelsDev(options: RefreshOptions): Promise<RefreshResult> {
  const url = modelsDevUrl(options.env);
  const now = options.now ?? Date.now;
  const before = loadModelsDevIndex(options.dataDir);
  const fail = (reason: string): RefreshResult => ({
    status: "failed",
    url,
    index: before,
    warning: msg().errors.models.refreshFailed(reason),
  });
  const list = snapshotList();
  const unknown = (options.providers ?? []).filter((p) => !list.providers.includes(p));
  if (unknown.length > 0)
    return fail(msg().errors.models.notListed(unknown.join(", "), list.providers.join(", ")));
  let fresh: ModelsDevData;
  try {
    const response = await (options.fetch ?? fetch)(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? MODELS_DEV_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    fresh = buildSnapshot(await response.json(), list, options.providers);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const fetchedAt = new Date(now()).toISOString();
  const previous = readModelsDevCache(options.dataDir);
  const kept = previous !== undefined && overrideApplies(previous) ? previous.providers : {};
  writeModelsDevCache(options.dataDir, {
    version: 2,
    url,
    fetchedAt,
    providers: { ...kept, ...fresh },
  });
  const diff = diffSnapshots(before.data, fresh);
  const changed = diff.added.length + diff.removed.length + diff.changed.length > 0;
  return {
    status: changed ? "updated" : "unchanged",
    url,
    fetchedAt,
    diff,
    index: loadModelsDevIndex(options.dataDir),
  };
}

/** 刷新结果的说明（命令输出用）：一行状态 + 新增 / 删除 / 变化清单。 */
export function describeRefresh(result: RefreshResult, limit = 20): string {
  const m = msg().errors.models;
  const lines = [
    m.refreshStatus(
      result.status,
      result.index.providerCount,
      result.index.modelCount,
      result.fetchedAt,
    ),
  ];
  const section = (kind: "added" | "removed" | "changed", items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push(m.section(kind, items.length));
    for (const item of items.slice(0, limit)) lines.push(`  ${item}`);
    if (items.length > limit) lines.push(m.more(items.length - limit));
  };
  if (result.diff !== undefined) {
    section("added", result.diff.added);
    section("removed", result.diff.removed);
    section("changed", result.diff.changed);
  }
  return lines.join("\n");
}
