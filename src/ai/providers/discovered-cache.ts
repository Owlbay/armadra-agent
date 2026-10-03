/**
 * 发现得到的模型列表缓存：`<dataDir>/models/discovered/<provider>.json`。
 *
 * 模型表为空、接受任意 slug 的供应商（`chatgpt` 的订阅后端）在选择器里原本一个模型都看不到。
 * `ama auth login chatgpt` 成功后与 `ama models discover chatgpt` 把账户可用的 slug 写进这里；组装注册表时
 * （`mergeDiscoveredModels`）并入**模型表仍为空**的供应商，元数据用 models.dev（快照 ⊕ 用户刷新）补全。
 * `ama auth logout chatgpt` 删掉它。只存 slug、显示名、后端给的元数据（codex：上下文窗口、输入模态、推理强度，
 * models.dev 补不到时用）、flavor 与时间戳——没有 token、账户 id。
 *
 * ChatGPT 的缓存带登录 flavor；组装时与当前登录的 flavor 不符视为过期、不并入（选择器提示重新发现）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model, ModelThinkingLevel, ProviderData } from "../types.js";
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
  models: DiscoveredCacheModel[];
}

/** 缓存里的一个模型：slug、显示名与后端给的元数据（都可缺）。 */
export interface DiscoveredCacheModel {
  id: string;
  name?: string;
  contextWindow?: number;
  input?: ("text" | "image")[];
  reasoningLevels?: string[];
}

/** 缓存文件位置。 */
export function discoveredCachePath(dataDir: string, provider: string): string {
  return join(dataDir, "models", "discovered", `${provider}.json`);
}

/** 未知值 → 缓存模型；id 不对返回 undefined，元数据字段形状不对的丢掉。 */
function toEntry(value: unknown): DiscoveredCacheModel | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const { id, name, contextWindow, input, reasoningLevels } = raw;
  if (typeof id !== "string" || id === "") return undefined;
  const out: DiscoveredCacheModel = { id };
  if (typeof name === "string" && name !== "") out.name = name;
  if (typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0)
    out.contextWindow = contextWindow;
  if (Array.isArray(input) && input.includes("text"))
    out.input = (["text", "image"] as const).filter((x) => input.includes(x));
  if (Array.isArray(reasoningLevels) && reasoningLevels.every((x) => typeof x === "string"))
    out.reasoningLevels = reasoningLevels as string[];
  return out;
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
    models: file.models.map(toEntry).filter((m) => m !== undefined),
  };
}

/** 写缓存（先写临时文件再改名）；返回路径。 */
export function writeDiscoveredCache(
  dataDir: string,
  provider: string,
  input: {
    models: readonly (Omit<DiscoveredCacheModel, "name"> & { name?: string | undefined })[];
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
    models: input.models.map(toEntry).filter((m) => m !== undefined),
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

const EFFORT_LEVELS: readonly ModelThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

/** 后端给的推理强度 → 思考级别映射（`none` 对应 off；没列出的级别不支持）。 */
export function thinkingMapOf(
  levels: readonly string[],
): Partial<Record<ModelThinkingLevel, string | null>> {
  const map: Partial<Record<ModelThinkingLevel, string | null>> = {
    off: levels.includes("none") ? "none" : null,
  };
  for (const level of EFFORT_LEVELS) map[level] = levels.includes(level) ? level : null;
  return map;
}

/** models.dev 没补上的字段用后端给的元数据。 */
function withBackendMetadata(model: Model, cached: DiscoveredCacheModel, matched: boolean): void {
  if (model.contextWindow === undefined && cached.contextWindow !== undefined)
    model.contextWindow = cached.contextWindow;
  if (matched) return;
  if (cached.input !== undefined) model.input = [...cached.input];
  const efforts = (cached.reasoningLevels ?? []).filter((x) => x !== "none");
  if (efforts.length > 0) {
    model.reasoning = true;
    model.thinkingLevelMap = thinkingMapOf(cached.reasoningLevels ?? []);
  }
}

/** 缓存里的模型 → 注册表模型（models.dev 补元数据，补不到用后端给的，再补不到用自定义缺省）。 */
export function discoveredModels(
  file: DiscoveredCacheFile,
  provider: ProviderData,
  modelsDev: () => ModelsDevIndex | undefined,
): Model[] {
  return file.models.map((m) => {
    const { entry, metadata } = enrichEntry(
      m.name ? { id: m.id, name: m.name } : { id: m.id },
      modelsDev,
    );
    const model = withCustomDefaults(entry, provider.id, provider.api);
    withBackendMetadata(model, m, metadata.match !== undefined);
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
  /** 当前登录的 flavor（只有 OAuth 供应商有）：缓存的 flavor 与之不符视为过期，不并入。 */
  loginFlavor: (providerId: string) => string | undefined = () => undefined,
): string[] {
  const merged: string[] = [];
  for (const provider of registry.list()) {
    if (provider.models.length > 0 || !provider.requiresApiKey) continue;
    const file = readDiscoveredCache(dataDir, provider.id);
    if (file === undefined || file.models.length === 0) continue;
    const flavor = loginFlavor(provider.id);
    if (flavor !== undefined && file.flavor !== undefined && file.flavor !== flavor) continue;
    registry.addModels(provider.id, discoveredModels(file, provider, modelsDev), "discovered");
    merged.push(provider.id);
  }
  return merged;
}
