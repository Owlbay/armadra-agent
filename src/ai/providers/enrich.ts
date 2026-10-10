/**
 * 用 models.dev 缓存给自定义模型补元数据（docs/guides/providers.md「模型元数据：models.dev」）。
 *
 * 优先级：用户配置写了的字段 > models.dev > 自定义缺省（maxTokens 8192、input ["text"]、
 * reasoning false、不猜 contextWindow）。内置目录的模型不经过这里：目录在 catalog.ts 里已经
 * 「快照 ⊕ 覆盖」合并好（[W5-M1]），这里只给它们标来源。只读传入的索引，不联网。
 *
 * [ME-D] 中转模型继承官方目录（D10）：`catalog` 没关时按 id 别名（或显式 `provider/id`）唯一命中
 * 内置目录条目，继承模型固有属性 `reasoning`、`input`、`thinkingLevelMap`、`promptCache.minTokens`、
 * `compat.requiresReasoningContentOnAssistantMessages`（用户写了的不覆盖），并把 models.dev 显式
 * 匹配改为该条目的快照引用；不继承价格、TTL 与 `thinkingFormat`。去掉思考档后缀才命中时（中转按
 * id 定思考档）不继承思考设置。models.dev 仍补不出的窗口 / 输出上限取目录值。
 */

import type { ModelConfig } from "../../config/types.js";
import type { Model } from "../types.js";
import { catalogByAlias, catalogByRef, catalogInherited, type CatalogAliasHit } from "./catalog.js";
import {
  ENRICHABLE_FIELDS,
  MODELS_DEV_MAX_OUTPUT,
  modelsDevFields,
  type EnrichableField,
  type ModelsDevIndex,
  type ModelsDevMatch,
} from "./models-dev.js";
import { msg } from "../../i18n/index.js";

export type FieldSource = "config" | "catalog" | "catalog-alias" | "models.dev" | "default";

export interface ModelMetadata {
  sources: Record<EnrichableField, FieldSource>;
  /** models.dev 匹配结果；未查（没有缓存或 `modelsDev: false`）为 undefined。 */
  match?: ModelsDevMatch | undefined;
  /** 是否查过 models.dev（有缓存且没关闭）。 */
  looked: boolean;
  /** models.dev 的 tool_call。 */
  toolCall?: boolean;
  /** [ME-D] 按 id 继承的内置目录条目 `provider/id`。 */
  catalog?: string;
  /** 显式 `catalog` / `modelsDev` 引用不命中时的告警（注册表转成 warnings，#154）。 */
  warnings?: string[];
}

export type ModelsDevSource = ModelsDevIndex | (() => ModelsDevIndex | undefined) | undefined;

/** 惰性取索引：只有真的要补字段时才读缓存（启动时没有自定义模型就不读约 2 MB 的缓存）。 */
export function lazyIndex(source: ModelsDevSource): () => ModelsDevIndex | undefined {
  if (typeof source !== "function") return () => source;
  let loaded = false;
  let index: ModelsDevIndex | undefined;
  return () => {
    if (!loaded) {
      loaded = true;
      try {
        index = source();
      } catch {
        index = undefined;
      }
    }
    return index;
  };
}

/** 只作说明的元数据（不进来源表）：缺了就从 models.dev 补。 */
const METADATA_FIELDS = ["family", "knowledge", "releaseDate", "inputLimit", "status"] as const;

function needsLookup(entry: Partial<Model>): boolean {
  return ENRICHABLE_FIELDS.some((field) => entry[field] === undefined);
}

type EnrichedEntry = Omit<ModelConfig, "modelsDev" | "channels" | "catalog">;

function catalogHit(entry: ModelConfig): CatalogAliasHit | undefined {
  if (entry.catalog === false) return undefined;
  return typeof entry.catalog === "string" ? catalogByRef(entry.catalog) : catalogByAlias(entry.id);
}

/** 目录固有属性（用户写了的不覆盖）。 */
function inheritIntrinsic(
  out: EnrichedEntry,
  hit: CatalogAliasHit,
  sources: Record<EnrichableField, FieldSource>,
): void {
  const model = hit.model;
  if (out.input === undefined && model.input !== undefined) {
    out.input = [...model.input];
    sources.input = "catalog-alias";
  }
  if (hit.tier === undefined) {
    if (out.reasoning === undefined) {
      out.reasoning = model.reasoning;
      sources.reasoning = "catalog-alias";
    }
    if (out.thinkingLevelMap === undefined && model.thinkingLevelMap !== undefined)
      out.thinkingLevelMap = structuredClone(model.thinkingLevelMap);
  }
  const minTokens = model.promptCache?.minTokens;
  if (minTokens !== undefined && out.promptCache?.minTokens === undefined)
    out.promptCache = { ...out.promptCache, minTokens };
  const requires = model.compat?.requiresReasoningContentOnAssistantMessages;
  if (
    requires !== undefined &&
    out.compat?.requiresReasoningContentOnAssistantMessages === undefined
  )
    out.compat = { ...out.compat, requiresReasoningContentOnAssistantMessages: requires };
}

/** models.dev 之后仍缺的窗口与输出上限取目录值（输出按 models.dev 口径封顶）。 */
function fillLimits(
  out: EnrichedEntry,
  hit: CatalogAliasHit,
  sources: Record<EnrichableField, FieldSource>,
): void {
  if (out.contextWindow === undefined && hit.model.contextWindow !== undefined) {
    out.contextWindow = hit.model.contextWindow;
    sources.contextWindow = "catalog-alias";
  }
  if (out.maxTokens === undefined) {
    out.maxTokens = Math.min(hit.model.maxTokens, MODELS_DEV_MAX_OUTPUT);
    sources.maxTokens = "catalog-alias";
  }
}

/**
 * 补全一个自定义模型条目（config 的 `models[]` 或合成的模型）。返回补过字段的条目（不含
 * `modelsDev` / `channels` / `catalog` 这些配置专用键）与每个字段的来源。显式 `catalog: "provider/id"`
 * 或 `modelsDev` 引用不命中时记入 `metadata.warnings`（`providerId` 用于告警文案）；写错的 `catalog`
 * 不回落按 id 继承——用户显式指定，按指定失败处理。
 */
export function enrichEntry(
  entry: ModelConfig,
  index: () => ModelsDevIndex | undefined,
  providerId?: string,
): { entry: EnrichedEntry; metadata: ModelMetadata } {
  const { modelsDev, channels: _channels, catalog: _catalog, ...rest } = entry;
  const sources = {} as Record<EnrichableField, FieldSource>;
  for (const field of ENRICHABLE_FIELDS) {
    sources[field] = rest[field] !== undefined ? "config" : "default";
  }
  const metadata: ModelMetadata = { sources, looked: false };
  const out: EnrichedEntry = { ...rest };
  const warnings: string[] = [];
  const ref = `${providerId ?? "?"}/${entry.id}`;
  const hit = catalogHit(entry);
  if (hit !== undefined) {
    metadata.catalog = hit.ref;
    inheritIntrinsic(out, hit, sources);
  } else if (typeof entry.catalog === "string") {
    warnings.push(`catalog "${entry.catalog}" for "${ref}" not found; ignored`);
  }
  const explicit = typeof modelsDev === "string" ? modelsDev : hit?.snapshotRef;
  const lookup = modelsDev !== false && (needsLookup(out) || modelsDev !== undefined);
  const idx = lookup ? index() : undefined;
  if (idx !== undefined) {
    metadata.looked = true;
    // 目录给的快照引用在用户刷新的数据里不存在时，回落按 id 匹配
    const match =
      idx.match(entry.id, explicit) ??
      (modelsDev === undefined && explicit !== undefined ? idx.match(entry.id) : undefined);
    metadata.match = match;
    if (match !== undefined) {
      const fields = modelsDevFields(match.model);
      if (fields.toolCall !== undefined) metadata.toolCall = fields.toolCall;
      for (const field of ENRICHABLE_FIELDS) {
        if (out[field] !== undefined) continue;
        // 思考档写在 id 里的中转模型：不让 models.dev 打开思考参数
        if (field === "reasoning" && hit?.tier !== undefined) continue;
        const value = fields[field];
        if (value === undefined) continue;
        (out as Record<string, unknown>)[field] = structuredClone(value);
        sources[field] = "models.dev";
      }
      if (out.name === undefined && fields.name !== undefined) out.name = fields.name;
      for (const field of METADATA_FIELDS) {
        if (out[field] === undefined && fields[field] !== undefined)
          (out as Record<string, unknown>)[field] = fields[field];
      }
    }
  }
  if (typeof modelsDev === "string" && metadata.looked && metadata.match === undefined)
    warnings.push(`modelsDev "${modelsDev}" for "${ref}" not found`);
  if (hit !== undefined && modelsDev !== false) fillLimits(out, hit, sources);
  if (warnings.length > 0) metadata.warnings = warnings;
  return { entry: out, metadata };
}

/**
 * 内置目录模型的来源：目录自己写的为 catalog，从入库快照继承的为 models.dev（catalog.ts），
 * 都没有的为缺省。
 */
export function catalogMetadata(model: Model): ModelMetadata {
  const inherited = catalogInherited(model.provider, model.id);
  const sources = {} as Record<EnrichableField, FieldSource>;
  for (const field of ENRICHABLE_FIELDS) {
    sources[field] = inherited.includes(field)
      ? "models.dev"
      : model[field] !== undefined
        ? "catalog"
        : "default";
  }
  return { sources, looked: false };
}

export function sourceText(source: FieldSource): string {
  return msg().errors.models.source(source);
}
