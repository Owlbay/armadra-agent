/**
 * 模型目录（设计 §3.4）：`catalog/*.json` 是数据源（人工校对、PR 更新），随包携带。
 *
 * 运行时零依赖、bundle 为单文件，不能在运行时读 JSON 文件；`catalog-data.ts` 是由 JSON 生成
 * 的字符串表（`UPDATE_CATALOG=1 pnpm vitest run src/ai/providers/catalog.test.ts` 重新生成，
 * 测试守住两者一致）。本模块解析并校验它，另提供覆盖合并。
 *
 * 必填字段：id、name、maxTokens、reasoning；contextWindow 与 cost「宁缺不猜」——数据源里
 * 不确定的就不写（缺 contextWindow → 关自动压缩并警告；缺 cost → 显示 `$?`）。`promptCache`
 * （TTL 秒数与最小可缓存长度）同样只写有公开依据的值（第三波 §1.4），留空 = 不承诺。
 */

import { AmaError } from "../../errors.js";
import type { Model, ModelCatalogFile, ModelThinkingLevel } from "../types.js";
import { CATALOG_SOURCES } from "./catalog-data.js";
import { THINKING_LEVELS } from "../thinking.js";

export type CatalogModel = ModelCatalogFile["models"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 校验一个模型条目，返回问题列表（空 = 合法）。 */
export function checkCatalogModel(value: unknown, path: string): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return [`${path}: must be an object`];
  if (typeof value["id"] !== "string" || value["id"].length === 0) problems.push(`${path}.id`);
  if (typeof value["name"] !== "string") problems.push(`${path}.name`);
  if (typeof value["reasoning"] !== "boolean") problems.push(`${path}.reasoning`);
  if (!isNonNegative(value["maxTokens"]) || value["maxTokens"] === 0) {
    problems.push(`${path}.maxTokens`);
  }
  if (value["contextWindow"] !== undefined && !isNonNegative(value["contextWindow"])) {
    problems.push(`${path}.contextWindow`);
  }
  const input = value["input"];
  if (
    input !== undefined &&
    (!Array.isArray(input) || !input.every((i) => i === "text" || i === "image"))
  ) {
    problems.push(`${path}.input`);
  }
  const cost = value["cost"];
  if (cost !== undefined) {
    if (!isRecord(cost)) problems.push(`${path}.cost`);
    else {
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
        if (!isNonNegative(cost[key])) problems.push(`${path}.cost.${key}`);
      }
      if (cost["tiers"] !== undefined && !Array.isArray(cost["tiers"])) {
        problems.push(`${path}.cost.tiers`);
      }
    }
  }
  const promptCache = value["promptCache"];
  if (promptCache !== undefined) {
    if (!isRecord(promptCache)) problems.push(`${path}.promptCache`);
    else {
      for (const [key, seconds] of Object.entries(promptCache)) {
        const known = key === "short" || key === "long" || key === "minTokens";
        if (!known || !Number.isInteger(seconds) || (seconds as number) <= 0) {
          problems.push(`${path}.promptCache.${key}`);
        }
      }
      const { short, long } = promptCache;
      if (typeof short === "number" && typeof long === "number" && long < short) {
        problems.push(`${path}.promptCache.long < short`);
      }
    }
  }
  const map = value["thinkingLevelMap"];
  if (map !== undefined) {
    if (!isRecord(map)) problems.push(`${path}.thinkingLevelMap`);
    else {
      for (const [level, mapped] of Object.entries(map)) {
        const okLevel = (THINKING_LEVELS as readonly string[]).includes(level);
        const okValue = mapped === null || typeof mapped === "string" || typeof mapped === "number";
        if (!okLevel || !okValue) problems.push(`${path}.thinkingLevelMap.${level}`);
      }
    }
  }
  return problems;
}

export function parseCatalogFile(value: unknown, source: string): ModelCatalogFile {
  const problems: string[] = [];
  if (!isRecord(value)) problems.push("$: must be an object");
  else {
    if (value["version"] !== 1) problems.push("$.version must be 1");
    if (typeof value["provider"] !== "string") problems.push("$.provider");
    if (!Array.isArray(value["models"])) problems.push("$.models must be an array");
    else {
      const seen = new Set<string>();
      value["models"].forEach((model, i) => {
        problems.push(...checkCatalogModel(model, `$.models[${i}]`));
        const id = isRecord(model) ? model["id"] : undefined;
        if (typeof id === "string") {
          if (seen.has(id)) problems.push(`$.models[${i}].id duplicated: ${id}`);
          seen.add(id);
        }
      });
    }
  }
  if (problems.length > 0) {
    throw new AmaError(
      "config_invalid",
      `model catalog ${source} is invalid: ${problems.join(", ")}`,
    );
  }
  return value as unknown as ModelCatalogFile;
}

let cache: Map<string, CatalogModel[]> | undefined;

/** 内置目录：供应商 id → 模型条目（深拷贝，调用方可随意修改）。 */
export function loadBuiltinCatalog(): Map<string, CatalogModel[]> {
  if (!cache) {
    cache = new Map();
    for (const [provider, raw] of Object.entries(CATALOG_SOURCES)) {
      const file = parseCatalogFile(JSON.parse(raw), `catalog/${provider}.json`);
      cache.set(file.provider, file.models);
    }
  }
  const copy = new Map<string, CatalogModel[]>();
  for (const [provider, models] of cache) copy.set(provider, structuredClone(models));
  return copy;
}

/** 目录条目 → Model（补 provider / api 与缺省 input）。 */
export function toModel(entry: CatalogModel, provider: string, api: Model["api"]): Model {
  return { ...structuredClone(entry), input: entry.input ?? ["text"], provider, api };
}

/** 自定义模型缺省：maxTokens 8192、reasoning false、input ["text"]、name = id；不猜 contextWindow。 */
export function withCustomDefaults(
  entry: Partial<Omit<Model, "provider" | "api">> & { id: string },
  provider: string,
  api: Model["api"],
): Model {
  return {
    ...structuredClone(entry),
    name: entry.name ?? entry.id,
    input: entry.input ?? ["text"],
    reasoning: entry.reasoning ?? false,
    maxTokens: entry.maxTokens ?? 8192,
    provider,
    api,
  };
}

/** 只改元数据：浅合并，`compat` / `cost` / `thinkingLevelMap` / `headers` 再合并一层。 */
export function applyModelOverride(
  model: Model,
  override: Partial<Omit<Model, "provider" | "api">> & { id: string },
): Model {
  const { id: _id, ...rest } = override;
  const next: Model = { ...model, ...structuredClone(rest) };
  if (override.compat && model.compat) next.compat = { ...model.compat, ...override.compat };
  if (override.cost && model.cost) next.cost = { ...model.cost, ...override.cost };
  if (override.headers && model.headers) next.headers = { ...model.headers, ...override.headers };
  if (override.thinkingLevelMap && model.thinkingLevelMap) {
    next.thinkingLevelMap = {
      ...model.thinkingLevelMap,
      ...override.thinkingLevelMap,
    } as Partial<Record<ModelThinkingLevel, string | number | null>>;
  }
  return next;
}
