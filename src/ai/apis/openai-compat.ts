/**
 * OpenAI 兼容线的 compat 推断（设计 §3.3）。
 *
 * 顺序：保守缺省 ← 推断表（先按 provider id，再按 baseUrl 子串）← `provider.compat` ←
 * `model.compat`（字段级覆盖，undefined 不覆盖）。显式配置永远胜过推断。
 *
 * 缺省是「最保守的 OpenAI 兼容服务」：`max_tokens`、`system` 角色、不发 `store` /
 * `reasoning_effort` / `strict`。只有 OpenAI 官方端点打开 OpenAI 专有开关。
 * 表里每一项都应对应一个已验证的差异（文档或真实样本）；没验证过的不要加。
 */

import type { Model, OpenAICompletionsCompat, ProviderCompat, ProviderData } from "../types.js";

export const OPENAI_COMPAT_KEYS = [
  "maxTokensField",
  "supportsDeveloperRole",
  "supportsUsageInStreaming",
  "supportsFinishReason",
  "supportsReasoningEffort",
  "thinkingFormat",
  "thinkingTokenBudgetField",
  "requiresReasoningContentOnAssistantMessages",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "supportsMidConvoSystemMessages",
  "cacheControlFormat",
  "supportsStrictTools",
  "supportsStore",
] as const satisfies readonly (keyof OpenAICompletionsCompat)[];

export const CONSERVATIVE_COMPAT: Readonly<OpenAICompletionsCompat> = {
  maxTokensField: "max_tokens",
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  supportsReasoningEffort: false,
  thinkingFormat: "openai",
  requiresReasoningContentOnAssistantMessages: false,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  supportsMidConvoSystemMessages: false,
  cacheControlFormat: "none",
  supportsStrictTools: false,
  supportsStore: false,
};

type Patch = Partial<OpenAICompletionsCompat>;

interface InferenceRule {
  /** 供应商 id（内置 id）。 */
  provider: string;
  /** baseUrl 子串（自定义供应商指向同一服务时命中）。 */
  baseUrl: string;
  patch: (modelId: string) => Patch;
}

/**
 * 推断表：内置里有 OpenAI 兼容线（Chat 渠道或单渠道回落）的各家（anthropic / google 不走本协议）。
 * [W5-M2] 新增四家暂无已验证的差异，按保守缺省（空补丁）登记。
 */
export const INFERENCE_RULES: readonly InferenceRule[] = [
  {
    provider: "openai",
    baseUrl: "api.openai.com",
    patch: () => ({
      maxTokensField: "max_completion_tokens",
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      supportsStrictTools: true,
      supportsStore: true,
    }),
  },
  {
    provider: "deepseek",
    baseUrl: "deepseek.com",
    patch: () => ({
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    }),
  },
  {
    provider: "moonshot",
    baseUrl: "moonshot.",
    patch: () => ({ thinkingFormat: "deepseek", supportsMidConvoSystemMessages: true }),
  },
  { provider: "zhipu", baseUrl: "bigmodel.cn", patch: () => ({ thinkingFormat: "zai" }) },
  {
    provider: "dashscope",
    baseUrl: "dashscope",
    patch: () => ({ thinkingFormat: "qwen", thinkingTokenBudgetField: "thinking_budget" }),
  },
  {
    provider: "openrouter",
    baseUrl: "openrouter.ai",
    patch: (modelId) => ({
      maxTokensField: "max_completion_tokens",
      supportsReasoningEffort: true,
      thinkingFormat: "openrouter",
      supportsDeveloperRole: modelId.startsWith("openai/") || modelId.startsWith("anthropic/"),
      cacheControlFormat: modelId.startsWith("anthropic/") ? "anthropic" : "none",
    }),
  },
  {
    provider: "groq",
    baseUrl: "groq.com",
    patch: () => ({
      maxTokensField: "max_completion_tokens",
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
    }),
  },
  {
    provider: "xai",
    baseUrl: "api.x.ai",
    patch: () => ({ maxTokensField: "max_completion_tokens", supportsReasoningEffort: true }),
  },
  {
    provider: "mistral",
    baseUrl: "mistral.ai",
    patch: () => ({ thinkingFormat: "none", requiresToolResultName: true }),
  },
  { provider: "minimax", baseUrl: "minimax", patch: () => ({}) },
  { provider: "stepfun", baseUrl: "stepfun", patch: () => ({}) },
  { provider: "volcengine", baseUrl: "volces.com", patch: () => ({}) },
  { provider: "tencent", baseUrl: "tencentmaas.com", patch: () => ({}) },
  { provider: "ollama", baseUrl: ":11434", patch: () => ({}) },
  { provider: "lmstudio", baseUrl: ":1234", patch: () => ({}) },
];

/** 命中的推断规则（先 provider id，后 baseUrl 子串）。 */
export function findInferenceRule(providerId: string, baseUrl: string): InferenceRule | undefined {
  return (
    INFERENCE_RULES.find((rule) => rule.provider === providerId) ??
    INFERENCE_RULES.find((rule) => baseUrl.toLowerCase().includes(rule.baseUrl))
  );
}

/** 从 ProviderCompat 里挑出本协议的字段（undefined 跳过）。 */
export function pickOpenAICompat(compat: ProviderCompat | undefined): Patch {
  const out: Record<string, unknown> = {};
  if (!compat) return out;
  for (const key of OPENAI_COMPAT_KEYS) {
    const value = compat[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Patch;
}

/** 推断（不含显式配置）。 */
export function inferOpenAICompat(
  providerId: string,
  baseUrl: string,
  modelId: string,
): OpenAICompletionsCompat {
  const rule = findInferenceRule(providerId, baseUrl);
  return { ...CONSERVATIVE_COMPAT, ...(rule ? rule.patch(modelId) : {}) };
}

/**
 * 完整 compat：推断 ← provider.compat ← model.compat。`provider` 缺省时只用 model
 * 自带信息（registry 物化后的模型已把 provider.compat 合进 model.compat）。
 */
export function detectCompat(model: Model, provider?: ProviderData): OpenAICompletionsCompat {
  const providerId = provider?.id ?? model.provider;
  const baseUrl = model.baseUrl ?? provider?.baseUrl ?? "";
  return {
    ...inferOpenAICompat(providerId, baseUrl, model.id),
    ...pickOpenAICompat(provider?.compat),
    ...pickOpenAICompat(model.compat),
  };
}
