/**
 * anthropic-messages 的 compat 推断（[W5-M2]，docs/history/wave5-plan.md §3.1、D10）：按请求主机给缺省。
 *
 * 顺序：保守缺省 ← 主机表（`model.baseUrl` 的主机名子串，先命中先用）← `provider.compat` ←
 * `model.compat`（字段级覆盖，undefined 不覆盖）。registry 物化后的模型已把供应商 / 渠道 compat 合进
 * `model.compat`，所以显式配置永远胜过推断。
 *
 * - `sendInterleavedThinkingBeta`：官方端点开；表里的第三方端点关（DeepSeek 文档写明忽略 beta 头，其余
 *   未写明接受，不发未知 beta 头最稳）；不在表里的主机（中转）只对 `claude*` 模型开——中转转发 Claude
 *   时仍需要交错思考。
 * - `sendCacheControl`：缺省开；DeepSeek 文档写明 `cache_control` 被忽略，关掉以减小请求体。
 * - `adaptiveThinking` 只由目录 / 配置给（官方模型逐条写在 catalog/anthropic.json），表里不推断。
 * - 缓存保留层级（1h TTL）等缓存能力在 cache-params.ts 的 `HOST_CACHE_CAPABILITIES`，不在这里。
 * - OpenRouter：流式 usage 只出现在 `message_delta`，`applyAnthropicUsage` 本就按非 null 字段合并，
 *   不需要开关（anthropic-compat.test.ts 核对）。
 *
 * 表里每一项都对应厂商文档或实测（docs/research/R1-models-protocols.md §2.1、docs/guides/providers.md「渠道实测」）。
 */

import type { AnthropicMessagesCompat, Model, ProviderCompat, ProviderData } from "../types.js";

export type ResolvedAnthropicCompat = Required<AnthropicMessagesCompat>;

export const ANTHROPIC_COMPAT_KEYS = [
  "supportsCacheControlOnTools",
  "supportsTemperatureWithThinking",
  "adaptiveThinking",
  "maxCacheBreakpoints",
  "sendInterleavedThinkingBeta",
  "sendCacheControl",
] as const satisfies readonly (keyof AnthropicMessagesCompat)[];

/** 未知主机的保守缺省（`sendInterleavedThinkingBeta` 另按模型 id 定，见 `hostDefaults`）。 */
export const DEFAULT_ANTHROPIC_COMPAT: Readonly<ResolvedAnthropicCompat> = {
  supportsCacheControlOnTools: true,
  supportsTemperatureWithThinking: false,
  adaptiveThinking: false,
  maxCacheBreakpoints: 4,
  sendInterleavedThinkingBeta: false,
  sendCacheControl: true,
};

export interface AnthropicHostRule {
  /** 主机名子串（小写）。 */
  host: string;
  patch: Partial<AnthropicMessagesCompat>;
}

const THIRD_PARTY: Partial<AnthropicMessagesCompat> = { sendInterleavedThinkingBeta: false };

/** 主机表：先命中先用。 */
export const ANTHROPIC_HOST_RULES: readonly AnthropicHostRule[] = [
  { host: "api.anthropic.com", patch: { sendInterleavedThinkingBeta: true } },
  {
    host: "api.deepseek.com",
    patch: { sendCacheControl: false, sendInterleavedThinkingBeta: false, adaptiveThinking: false },
  },
  { host: "open.bigmodel.cn", patch: THIRD_PARTY },
  { host: "api.z.ai", patch: THIRD_PARTY },
  { host: "api.moonshot.", patch: THIRD_PARTY },
  { host: "dashscope", patch: THIRD_PARTY },
  { host: "maas.aliyuncs.com", patch: THIRD_PARTY },
  { host: "api.minimax", patch: THIRD_PARTY },
  { host: "api.stepfun.", patch: THIRD_PARTY },
  { host: "tokenhub.tencentmaas.com", patch: THIRD_PARTY },
  { host: "volces.com", patch: THIRD_PARTY },
  // openrouter.ai 不进表：按未知主机处理（anthropic/claude-* 带交错思考 beta）
];

function hostOf(baseUrl: string | undefined): string {
  try {
    return new URL(baseUrl ?? "https://api.anthropic.com").hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 命中的主机规则（没有返回 undefined）。 */
export function findAnthropicHostRule(baseUrl: string | undefined): AnthropicHostRule | undefined {
  const host = hostOf(baseUrl);
  return host === "" ? undefined : ANTHROPIC_HOST_RULES.find((rule) => host.includes(rule.host));
}

/** 主机推断（不含显式配置）。未知主机：`claude*` 模型发交错思考 beta（中转转发 Claude）。 */
export function hostDefaults(
  baseUrl: string | undefined,
  modelId: string,
): ResolvedAnthropicCompat {
  const rule = findAnthropicHostRule(baseUrl);
  if (rule !== undefined) return { ...DEFAULT_ANTHROPIC_COMPAT, ...rule.patch };
  const claude = /(^|\/)claude/i.test(modelId);
  return { ...DEFAULT_ANTHROPIC_COMPAT, sendInterleavedThinkingBeta: claude };
}

function pick(compat: ProviderCompat | undefined): Partial<AnthropicMessagesCompat> {
  const out: Record<string, unknown> = {};
  for (const key of ANTHROPIC_COMPAT_KEYS) {
    const value = compat?.[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<AnthropicMessagesCompat>;
}

/** 完整 compat：主机推断 ← provider.compat ← model.compat。 */
export function detectAnthropicCompat(
  model: Model,
  provider?: ProviderData,
): ResolvedAnthropicCompat {
  return {
    ...hostDefaults(model.baseUrl ?? provider?.baseUrl, model.id),
    ...pick(provider?.compat),
    ...pick(model.compat),
  };
}
