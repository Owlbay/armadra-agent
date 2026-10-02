/**
 * 模型目录（设计 §3.4）：`catalog/*.json` 是数据源（人工校对、PR 更新），随包携带。
 *
 * 运行时零依赖、bundle 为单文件，不能在运行时读 JSON 文件；`catalog-data.ts` 是由 JSON 生成
 * 的字符串表（`UPDATE_CATALOG=1 pnpm vitest run src/ai/providers/catalog.test.ts` 重新生成，
 * 测试守住两者一致）。本模块解析并校验它，另提供覆盖合并。
 *
 * [W5-M1] 「快照 ⊕ 覆盖」格式（docs/wave5-plan.md §2.2、D6）：文件级 `modelsDev` 指向 models.dev
 * 快照里的供应商 id（`false` = 没有对应），条目按 `<modelsDev>/<id>`（或条目自己的 `modelsDev:
 * "provider/model"`）从快照继承数值事实——name、reasoning、contextWindow、maxTokens、input、cost、
 * family / knowledge / releaseDate / inputLimit / status；目录只写覆盖项与 ama 特有字段（`api`、
 * `thinkingLevelMap`、`promptCache`、`compat`、有意调小的 `maxTokens` 等）。`cost` 可只写要覆盖的键。
 * `_reason` 是注释字段（运行时忽略；写了它的条目不做冗余检查，用来有意钉住与快照相同的值）。
 *
 * 合并后的必填字段：id、name、maxTokens、reasoning；contextWindow 与 cost「宁缺不猜」——快照与目录
 * 都没有就不写（缺 contextWindow → 关自动压缩并警告；缺 cost → 显示 `$?`）。`promptCache`
 * （TTL 秒数与最小可缓存长度）同样只写有公开依据的值（第三波 §1.4），留空 = 不承诺。
 */

import { isDeepStrictEqual } from "node:util";
import { AmaError } from "../../errors.js";
import type { Api, Model, ModelCatalogFile, ModelThinkingLevel } from "../types.js";
import { CATALOG_SOURCES } from "./catalog-data.js";
import { THINKING_LEVELS } from "../thinking.js";
import { modelsDevFields, type ModelsDevIndex } from "./models-dev.js";
import { builtinSnapshotIndex } from "./models-dev-snapshot.js";

export type CatalogModel = ModelCatalogFile["models"][number];

/** 目录文件里的一条（覆盖格式）：除 id 外都可省，省掉的从快照继承。 */
export type CatalogEntry = Partial<Omit<CatalogModel, "cost">> & {
  id: string;
  cost?: Partial<NonNullable<CatalogModel["cost"]>>;
  /** 显式快照条目 `provider/model`；false = 不继承。 */
  modelsDev?: string | false;
  /** 注释：有意保留的覆盖（不做冗余检查）。 */
  _reason?: string;
  /** 模型级协议（OpenAI 推理模型走 responses 等）。 */
  api?: Api;
};

/** `catalog/*.json` 的文件形状（覆盖格式）。 */
export interface CatalogSourceFile {
  version: 1;
  provider: string;
  /** 快照里对应的 models.dev 供应商 id；false = 没有（本地服务）。 */
  modelsDev?: string | false;
  models: CatalogEntry[];
}

/** 从快照继承的字段（顺序即冗余检查与来源展示的顺序）。 */
export const INHERITED_FIELDS = [
  "name",
  "reasoning",
  "contextWindow",
  "maxTokens",
  "input",
  "cost",
  "family",
  "knowledge",
  "releaseDate",
  "inputLimit",
  "status",
] as const satisfies readonly (keyof CatalogModel)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 校验合并后的模型（必填齐全、cost 四个价都在），返回问题列表（空 = 合法）。 */
export function checkCatalogModel(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path}: must be an object`];
  const problems: string[] = [];
  if (typeof value["name"] !== "string") problems.push(`${path}.name`);
  if (typeof value["reasoning"] !== "boolean") problems.push(`${path}.reasoning`);
  if (value["maxTokens"] === undefined) problems.push(`${path}.maxTokens`);
  const cost = value["cost"];
  if (isRecord(cost)) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      if (cost[key] === undefined) problems.push(`${path}.cost.${key}`);
    }
  }
  return [...new Set([...problems, ...checkCatalogEntry(value, path)])];
}

/** 校验目录里的一条（覆盖格式：只查写了的字段），返回问题列表（空 = 合法）。 */
export function checkCatalogEntry(value: unknown, path: string): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return [`${path}: must be an object`];
  if (typeof value["id"] !== "string" || value["id"].length === 0) problems.push(`${path}.id`);
  if (value["name"] !== undefined && typeof value["name"] !== "string")
    problems.push(`${path}.name`);
  if (value["reasoning"] !== undefined && typeof value["reasoning"] !== "boolean")
    problems.push(`${path}.reasoning`);
  const modelsDev = value["modelsDev"];
  if (modelsDev !== undefined && modelsDev !== false && typeof modelsDev !== "string")
    problems.push(`${path}.modelsDev`);
  if (value["_reason"] !== undefined && typeof value["_reason"] !== "string")
    problems.push(`${path}._reason`);
  if (
    value["maxTokens"] !== undefined &&
    (!isNonNegative(value["maxTokens"]) || value["maxTokens"] === 0)
  ) {
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
        if (cost[key] !== undefined && !isNonNegative(cost[key]))
          problems.push(`${path}.cost.${key}`);
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

/** 一条目录条目对应的快照条目 `provider/model`（没有返回 undefined）。 */
export function snapshotRefOf(
  file: Pick<CatalogSourceFile, "modelsDev">,
  entry: Pick<CatalogEntry, "id" | "modelsDev">,
): string | undefined {
  if (entry.modelsDev === false) return undefined;
  if (typeof entry.modelsDev === "string") return entry.modelsDev;
  return typeof file.modelsDev === "string" ? `${file.modelsDev}/${entry.id}` : undefined;
}

/** 快照能给这条目录条目的字段（catalog 口径：不封顶、缺缓存价记 0）。 */
export function inheritedFields(
  file: Pick<CatalogSourceFile, "modelsDev">,
  entry: Pick<CatalogEntry, "id" | "modelsDev">,
  index: ModelsDevIndex = builtinSnapshotIndex(),
): Partial<CatalogModel> {
  const ref = snapshotRefOf(file, entry);
  const model = ref !== undefined ? index.get(ref) : undefined;
  if (model === undefined) return {};
  const fields = modelsDevFields(model, "catalog");
  const out: Partial<CatalogModel> = {};
  for (const key of INHERITED_FIELDS) {
    if (fields[key] !== undefined) (out as Record<string, unknown>)[key] = fields[key];
  }
  return out;
}

/** 合并：快照 ⊕ 目录条目（`cost` 按键合并）；返回模型与从快照继承的字段名。 */
export function resolveCatalogEntry(
  entry: CatalogEntry,
  inherited: Partial<CatalogModel>,
): { model: CatalogModel; inherited: string[] } {
  const { modelsDev: _modelsDev, _reason: _r, ...own } = structuredClone(entry);
  const model = { ...structuredClone(inherited), ...own } as CatalogModel;
  if (own.cost !== undefined && inherited.cost !== undefined)
    model.cost = { ...structuredClone(inherited.cost), ...own.cost };
  const from = INHERITED_FIELDS.filter((k) => own[k] === undefined && inherited[k] !== undefined);
  return { model, inherited: from };
}

/**
 * 与快照取值相同的覆盖项（冗余，测试报错；`UPDATE_CATALOG=1` 时自动删）：`name`、`cost.input` 一类路径。
 * 写了 `_reason` 的条目不查。
 */
export function redundantFields(entry: CatalogEntry, inherited: Partial<CatalogModel>): string[] {
  if (entry._reason !== undefined) return [];
  const out: string[] = [];
  for (const key of INHERITED_FIELDS) {
    const own = entry[key];
    const base = inherited[key];
    if (own === undefined || base === undefined) continue;
    if (key === "cost" && isRecord(own) && isRecord(base)) {
      for (const [k, v] of Object.entries(own))
        if (isDeepStrictEqual(v, base[k])) out.push(`cost.${k}`);
    } else if (isDeepStrictEqual(own, base)) out.push(key);
  }
  return out;
}

function fileProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["$: must be an object"];
  if (value["version"] !== 1) problems.push("$.version must be 1");
  if (typeof value["provider"] !== "string") problems.push("$.provider");
  const modelsDev = value["modelsDev"];
  if (modelsDev !== undefined && modelsDev !== false && typeof modelsDev !== "string")
    problems.push("$.modelsDev");
  if (!Array.isArray(value["models"])) problems.push("$.models must be an array");
  else {
    const seen = new Set<string>();
    value["models"].forEach((model, i) => {
      problems.push(...checkCatalogEntry(model, `$.models[${i}]`));
      const id = isRecord(model) ? model["id"] : undefined;
      if (typeof id === "string") {
        if (seen.has(id)) problems.push(`$.models[${i}].id duplicated: ${id}`);
        seen.add(id);
      }
    });
  }
  return problems;
}

function invalid(source: string, problems: readonly string[]): AmaError {
  return new AmaError(
    "config_invalid",
    `model catalog ${source} is invalid: ${problems.join(", ")}`,
  );
}

/** 校验文件形状（覆盖格式），不合并。 */
export function parseCatalogSource(value: unknown, source: string): CatalogSourceFile {
  const problems = fileProblems(value);
  if (problems.length > 0) throw invalid(source, problems);
  return value as CatalogSourceFile;
}

interface Resolved {
  file: ModelCatalogFile;
  /** 模型 id → 从快照继承的字段。 */
  inherited: Map<string, string[]>;
}

function resolveFile(
  file: CatalogSourceFile,
  source: string,
  index: ModelsDevIndex | undefined,
): Resolved {
  const problems: string[] = [];
  const inherited = new Map<string, string[]>();
  const builtin = builtinSnapshotIndex();
  const models = file.models.map((entry, i) => {
    const path = `$.models[${i}]`;
    let resolved = resolveCatalogEntry(entry, inheritedFields(file, entry, index ?? builtin));
    let found = checkCatalogModel(resolved.model, path);
    if (found.length > 0 && index !== undefined && index !== builtin) {
      // 用户刷新的数据缺字段（上游改版）：这一条退回内置快照，不让启动失败。
      resolved = resolveCatalogEntry(entry, inheritedFields(file, entry, builtin));
      found = checkCatalogModel(resolved.model, path);
    }
    problems.push(...found);
    inherited.set(entry.id, resolved.inherited);
    return resolved.model;
  });
  if (problems.length > 0) throw invalid(source, problems);
  return { file: { version: 1, provider: file.provider, models }, inherited };
}

/** 校验并合并（快照 ⊕ 目录）一个目录文件；`index` 缺省用内置快照。 */
export function parseCatalogFile(
  value: unknown,
  source: string,
  index?: ModelsDevIndex,
): ModelCatalogFile {
  return resolveFile(parseCatalogSource(value, source), source, index).file;
}

const caches = new WeakMap<ModelsDevIndex, Map<string, Resolved>>();
let lastInherited = new Map<string, readonly string[]>();

/**
 * 内置目录：供应商 id → 模型条目（深拷贝，调用方可随意修改）。`index` 缺省用内置快照；传入
 * 「快照 ⊕ 用户刷新」的索引时目录也吃刷新后的数值（缺字段的条目退回内置快照）。
 */
export function loadBuiltinCatalog(index?: ModelsDevIndex): Map<string, CatalogModel[]> {
  const key = index ?? builtinSnapshotIndex();
  let cache = caches.get(key);
  if (cache === undefined) {
    cache = new Map();
    for (const [provider, raw] of Object.entries(CATALOG_SOURCES)) {
      const source = `catalog/${provider}.json`;
      const resolved = resolveFile(parseCatalogSource(JSON.parse(raw), source), source, index);
      cache.set(resolved.file.provider, resolved);
    }
    caches.set(key, cache);
  }
  const copy = new Map<string, CatalogModel[]>();
  lastInherited = new Map();
  for (const [provider, resolved] of cache) {
    copy.set(provider, structuredClone(resolved.file.models));
    for (const [id, fields] of resolved.inherited) lastInherited.set(`${provider}/${id}`, fields);
  }
  return copy;
}

/** 最近一次 `loadBuiltinCatalog()` 里，该目录模型从快照继承的字段（来源展示用）。 */
export function catalogInherited(provider: string, modelId: string): readonly string[] {
  return lastInherited.get(`${provider}/${modelId}`) ?? [];
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
