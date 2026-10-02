/**
 * 用 models.dev 缓存给自定义模型补元数据（docs/providers.md「模型元数据：models.dev」）。
 *
 * 优先级：用户配置写了的字段 > models.dev > 自定义缺省（maxTokens 8192、input ["text"]、
 * reasoning false、不猜 contextWindow）。内置目录的模型不经过这里（目录本身就是人工校对的值）。
 * 只读传入的索引，不联网。
 */

import type { ModelConfig } from "../../config/types.js";
import type { Model } from "../types.js";
import {
  ENRICHABLE_FIELDS,
  modelsDevFields,
  type EnrichableField,
  type ModelsDevIndex,
  type ModelsDevMatch,
} from "./models-dev.js";

export type FieldSource = "config" | "catalog" | "models.dev" | "default";

export interface ModelMetadata {
  sources: Record<EnrichableField, FieldSource>;
  /** models.dev 匹配结果；未查（没有缓存或 `modelsDev: false`）为 undefined。 */
  match?: ModelsDevMatch | undefined;
  /** 是否查过 models.dev（有缓存且没关闭）。 */
  looked: boolean;
  /** models.dev 的 tool_call。 */
  toolCall?: boolean;
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

/**
 * 补全一个自定义模型条目（config 的 `models[]` 或合成的模型）。返回补过字段的条目（不含
 * `modelsDev` / `channels` 这些配置专用键）与每个字段的来源。
 */
export function enrichEntry(
  entry: ModelConfig,
  index: () => ModelsDevIndex | undefined,
): { entry: Omit<ModelConfig, "modelsDev" | "channels">; metadata: ModelMetadata } {
  const { modelsDev, channels: _channels, ...rest } = entry;
  const sources = {} as Record<EnrichableField, FieldSource>;
  for (const field of ENRICHABLE_FIELDS) {
    sources[field] = rest[field] !== undefined ? "config" : "default";
  }
  const metadata: ModelMetadata = { sources, looked: false };
  if (modelsDev === false || (!needsLookup(rest) && modelsDev === undefined)) {
    return { entry: rest, metadata };
  }
  const idx = index();
  if (idx === undefined) return { entry: rest, metadata };
  metadata.looked = true;
  const match = idx.match(entry.id, typeof modelsDev === "string" ? modelsDev : undefined);
  metadata.match = match;
  if (match === undefined) return { entry: rest, metadata };
  const fields = modelsDevFields(match.model);
  if (fields.toolCall !== undefined) metadata.toolCall = fields.toolCall;
  const out: Omit<ModelConfig, "modelsDev" | "channels"> = { ...rest };
  for (const field of ENRICHABLE_FIELDS) {
    if (out[field] !== undefined) continue;
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
  return { entry: out, metadata };
}

/** 内置目录模型的来源（全部 catalog；目录没写 contextWindow / cost 的为缺省）。 */
export function catalogMetadata(model: Model): ModelMetadata {
  const sources = {} as Record<EnrichableField, FieldSource>;
  for (const field of ENRICHABLE_FIELDS) {
    sources[field] = model[field] !== undefined ? "catalog" : "default";
  }
  return { sources, looked: false };
}

const SOURCE_TEXT: Record<FieldSource, string> = {
  config: "config",
  catalog: "目录",
  "models.dev": "models.dev",
  default: "缺省",
};

export function sourceText(source: FieldSource): string {
  return SOURCE_TEXT[source];
}
