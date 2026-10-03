/**
 * 发现得到的模型列表缓存：`<dataDir>/models/discovered/<provider>.json`。
 *
 * 模型表为空、接受任意 slug 的供应商（`chatgpt` 的订阅后端）在选择器里原本一个模型都看不到。
 * `ama auth login chatgpt` 成功后与 `ama models discover chatgpt` 把账户可用的 slug 写进这里；组装注册表时
 * （`mergeDiscoveredModels`）并入**模型表仍为空**的供应商，元数据用 models.dev（快照 ⊕ 用户刷新）补全。
 * `ama auth logout chatgpt` 删掉它。只存 slug、显示名、flavor 与时间戳——没有 token、账户 id。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model, ProviderData } from "../types.js";
import { withCustomDefaults } from "./catalog.js";
import { enrichEntry } from "./enrich.js";
import type { ModelsDevIndex } from "./models-dev.js";

export const DISCOVERED_CACHE_VERSION = 1;

export interface DiscoveredCacheFile {
  version: number;
  provider: string;
  /** ISO 时间。 */
  fetchedAt: string;
  /** ChatGPT 登录的 flavor（siwc / codex）；其它供应商不写。 */
  flavor?: string;
  models: { id: string; name?: string }[];
}

/** 缓存文件位置。 */
export function discoveredCachePath(dataDir: string, provider: string): string {
  return join(dataDir, "models", "discovered", `${provider}.json`);
}

function isEntry(value: unknown): value is { id: string; name?: string } {
  if (typeof value !== "object" || value === null) return false;
  const { id, name } = value as Record<string, unknown>;
  return typeof id === "string" && id !== "" && (name === undefined || typeof name === "string");
}

/** 读缓存；不存在、损坏或形状不对返回 undefined（不报错，选择器给提示行）。 */
export function readDiscoveredCache(
  dataDir: string,
  provider: string,
): DiscoveredCacheFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(discoveredCachePath(dataDir, provider), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const file = parsed as Partial<DiscoveredCacheFile>;
  if (file.provider !== provider || !Array.isArray(file.models)) return undefined;
  return {
    version: typeof file.version === "number" ? file.version : DISCOVERED_CACHE_VERSION,
    provider,
    fetchedAt: typeof file.fetchedAt === "string" ? file.fetchedAt : "",
    ...(typeof file.flavor === "string" ? { flavor: file.flavor } : {}),
    models: file.models
      .filter(isEntry)
      .map((m) => (m.name ? { id: m.id, name: m.name } : { id: m.id })),
  };
}

/** 写缓存（先写临时文件再改名）；返回路径。 */
export function writeDiscoveredCache(
  dataDir: string,
  provider: string,
  input: {
    models: readonly { id: string; name?: string | undefined }[];
    flavor?: string | undefined;
  },
  now: number = Date.now(),
): string {
  const path = discoveredCachePath(dataDir, provider);
  const file: DiscoveredCacheFile = {
    version: DISCOVERED_CACHE_VERSION,
    provider,
    fetchedAt: new Date(now).toISOString(),
    ...(input.flavor !== undefined ? { flavor: input.flavor } : {}),
    models: input.models.map((m) => (m.name ? { id: m.id, name: m.name } : { id: m.id })),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/** 删缓存；删了返回 true。 */
export function clearDiscoveredCache(dataDir: string, provider: string): boolean {
  const path = discoveredCachePath(dataDir, provider);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** 缓存里的模型 → 注册表模型（models.dev 补元数据，补不到用自定义缺省）。 */
export function discoveredModels(
  file: DiscoveredCacheFile,
  provider: ProviderData,
  modelsDev: () => ModelsDevIndex | undefined,
): Model[] {
  return file.models.map((m) => {
    const { entry } = enrichEntry(m.name ? { id: m.id, name: m.name } : { id: m.id }, modelsDev);
    const model = withCustomDefaults(entry, provider.id, provider.api);
    // 只挂发现时登录的 flavor 对应的渠道（订阅后端的另一条渠道用不了，不在说明与 `@` 行里出现）；
    // 缓存没写 flavor 或渠道不存在时用供应商的缺省渠道
    const names = (provider.channels ?? []).map((c) => c.name);
    if (names.length > 0) {
      const own =
        file.flavor !== undefined && names.includes(file.flavor) ? file.flavor : undefined;
      model.channels = [own ?? provider.defaultChannel ?? names[0]!];
    }
    return model;
  });
}

/** 注册表里能追加模型的最小接口（`ProviderRegistry.addModels`）。 */
export interface DiscoveredTarget {
  list(): readonly ProviderData[];
  addModels(providerId: string, models: readonly Model[], source?: "discovered"): void;
}

/**
 * 把缓存并入模型表为空的供应商（本地服务除外：它们每次启动现场探测）。返回并入了的供应商 id。
 */
export function mergeDiscoveredModels(
  registry: DiscoveredTarget,
  dataDir: string,
  modelsDev: () => ModelsDevIndex | undefined,
): string[] {
  const merged: string[] = [];
  for (const provider of registry.list()) {
    if (provider.models.length > 0 || !provider.requiresApiKey) continue;
    const file = readDiscoveredCache(dataDir, provider.id);
    if (file === undefined || file.models.length === 0) continue;
    registry.addModels(provider.id, discoveredModels(file, provider, modelsDev), "discovered");
    merged.push(provider.id);
  }
  return merged;
}
