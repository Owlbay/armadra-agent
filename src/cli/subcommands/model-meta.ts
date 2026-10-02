/**
 * 模型元数据的一行描述（`ama models list`、`ama config show`、`ama providers`）：上下文、输出、思考、
 * 图片、渠道，以及每个字段来自哪里（config / 目录 / models.dev / 缺省）与 models.dev 匹配。
 */

import { sourceText, type ModelMetadata } from "../../ai/providers/enrich.js";
import { matchLabel } from "../../ai/providers/models-dev.js";
import type { Model, ProviderRegistryApi } from "../../ai/types.js";

export function compactTokens(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** 注册表若是 ProviderRegistry（或同形状），取模型元数据来源；否则 undefined。 */
export function metadataOf(
  registry: ProviderRegistryApi,
  providerId: string,
  modelId: string,
): ModelMetadata | undefined {
  const r = registry as { modelMetadata?: (p: string, m: string) => ModelMetadata | undefined };
  return typeof r.modelMetadata === "function" ? r.modelMetadata(providerId, modelId) : undefined;
}

/** `ctx 262k · out 64k · 思考 · 图片 · 渠道 chat,messages`。 */
export function modelFlags(model: Model): string {
  return [
    `ctx ${compactTokens(model.contextWindow)}`,
    `out ${compactTokens(model.maxTokens)}`,
    model.reasoning ? "思考" : undefined,
    model.input.includes("image") ? "图片" : undefined,
    model.channels !== undefined ? `渠道 ${model.channels.join(",")}` : undefined,
  ]
    .filter((x) => x !== undefined)
    .join(" · ");
}

/**
 * 来源说明：全部来自内置目录时返回 undefined（不刷屏）；否则
 * `来源 ctx models.dev · out config · 图片 models.dev · …；models.dev 原厂 moonshotai/kimi-k2.5`。
 */
export function sourcesLine(metadata: ModelMetadata | undefined): string | undefined {
  if (metadata === undefined) return undefined;
  const values = Object.values(metadata.sources);
  if (values.every((s) => s === "catalog" || s === "default") && !metadata.looked) return undefined;
  const label: Record<keyof ModelMetadata["sources"], string> = {
    contextWindow: "ctx",
    maxTokens: "out",
    input: "图片",
    reasoning: "思考",
    cost: "价格",
  };
  const parts = (Object.keys(label) as (keyof ModelMetadata["sources"])[]).map(
    (field) => `${label[field]} ${sourceText(metadata.sources[field])}`,
  );
  const match = metadata.looked ? `；models.dev ${matchLabel(metadata.match)}` : "";
  const tools = metadata.toolCall === false ? "；不支持工具调用" : "";
  return `来源 ${parts.join(" · ")}${match}${tools}`;
}
