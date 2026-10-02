/**
 * detectCompat 真值表（设计 §15「compat」）：13 家内置 + 自定义 baseUrl。
 * 表里每一行都是「推断结果的完整快照」，改推断表必须同步改这里并说明依据。
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_PROVIDERS } from "../providers/builtin.js";
import type { Model, OpenAICompletionsCompat, ProviderData } from "../types.js";
import { CONSERVATIVE_COMPAT, detectCompat, inferOpenAICompat } from "./openai-compat.js";
import { detectAnthropicCompat } from "./anthropic-request.js";

type Row = [string, string, Partial<OpenAICompletionsCompat>];

/** [provider id, model id, 相对保守缺省的差异]。 */
const TRUTH: Row[] = [
  [
    "openai",
    "gpt-5.4",
    {
      maxTokensField: "max_completion_tokens",
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      supportsStrictTools: true,
      supportsStore: true,
    },
  ],
  [
    "deepseek",
    "deepseek-v4-pro",
    {
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    },
  ],
  ["moonshot", "kimi-k3", { thinkingFormat: "deepseek", supportsMidConvoSystemMessages: true }],
  ["zhipu", "glm-5.3", { thinkingFormat: "zai" }],
  [
    "dashscope",
    "qwen3.8-max",
    { thinkingFormat: "qwen", thinkingTokenBudgetField: "thinking_budget" },
  ],
  [
    "openrouter",
    "anthropic/claude-sonnet-5.5",
    {
      maxTokensField: "max_completion_tokens",
      supportsReasoningEffort: true,
      thinkingFormat: "openrouter",
      supportsDeveloperRole: true,
      cacheControlFormat: "anthropic",
    },
  ],
  [
    "openrouter",
    "deepseek/deepseek-v4-pro",
    {
      maxTokensField: "max_completion_tokens",
      supportsReasoningEffort: true,
      thinkingFormat: "openrouter",
    },
  ],
  [
    "groq",
    "openai/gpt-oss-120b",
    {
      maxTokensField: "max_completion_tokens",
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
    },
  ],
  ["xai", "grok-4.7", { maxTokensField: "max_completion_tokens", supportsReasoningEffort: true }],
  ["mistral", "mistral-large-latest", { thinkingFormat: "none", requiresToolResultName: true }],
  ["minimax", "MiniMax-M2.7", {}],
  ["stepfun", "step-5-preview", {}],
  ["volcengine", "doubao-seed-2-1-pro-260628", {}],
  ["tencent", "hy3", {}],
  ["ollama", "llama3", {}],
  ["lmstudio", "qwen", {}],
];

function provider(id: string): ProviderData {
  const base = BUILTIN_PROVIDERS.find((p) => p.id === id);
  if (!base) throw new Error(id);
  return { ...base, models: [], builtin: true };
}

function model(p: ProviderData, id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    provider: p.id,
    api: p.api,
    baseUrl: p.baseUrl,
    input: ["text"],
    reasoning: true,
    maxTokens: 1000,
    ...extra,
  };
}

describe("detectCompat 真值表", () => {
  it.each(TRUTH)("%s / %s", (id, modelId, diff) => {
    const p = provider(id);
    expect(detectCompat(model(p, modelId), p)).toEqual({ ...CONSERVATIVE_COMPAT, ...diff });
  });

  it("内置都有归宿：单渠道回落走 Chat 的都在推断表，anthropic / google / chatgpt 不走本协议", () => {
    const covered = new Set(TRUTH.map(([id]) => id));
    for (const p of BUILTIN_PROVIDERS) {
      if (p.api === "openai-completions") expect(covered.has(p.id), p.id).toBe(true);
      // [W6-O] chatgpt 只走 openai-responses（订阅后端）
      else expect(["anthropic", "google", "chatgpt"]).toContain(p.id);
    }
  });

  it.each<[string, Partial<OpenAICompletionsCompat>]>([
    ["https://proxy.example/deepseek.com/v1", { thinkingFormat: "deepseek" }],
    ["https://api.moonshot.ai/v1", { thinkingFormat: "deepseek" }],
    ["https://open.bigmodel.cn/api/coding/paas/v4", { thinkingFormat: "zai" }],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", { thinkingFormat: "qwen" }],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", { thinkingFormat: "qwen" }],
    ["https://openrouter.ai/api/v1", { thinkingFormat: "openrouter" }],
    ["https://api.groq.com/openai/v1", { supportsDeveloperRole: true }],
    ["https://api.x.ai/v1", { supportsReasoningEffort: true }],
    ["https://api.mistral.ai/v1", { requiresToolResultName: true }],
    ["http://localhost:11434/v1", {}],
    ["http://localhost:1234/v1", {}],
    ["https://my-vllm.internal/v1", {}],
  ])("自定义供应商按 baseUrl 推断：%s", (baseUrl, expected) => {
    const compat = inferOpenAICompat("my-proxy", baseUrl, "m");
    expect(compat).toMatchObject(expected);
    if (Object.keys(expected).length === 0)
      expect(compat).toMatchObject({ thinkingFormat: "openai" });
  });

  it("覆盖顺序：推断 ← provider.compat ← model.compat（undefined 不覆盖）", () => {
    const p = {
      ...provider("deepseek"),
      compat: { maxTokensField: "max_completion_tokens" as const, supportsStore: true },
    };
    const m = model(p, "x", {
      compat: { supportsStore: false, thinkingFormat: undefined } as unknown as NonNullable<
        Model["compat"]
      >,
    });
    const compat = detectCompat(m, p);
    expect(compat.maxTokensField).toBe("max_completion_tokens");
    expect(compat.supportsStore).toBe(false);
    expect(compat.thinkingFormat).toBe("deepseek");
    // 不传 provider 时只看 model 自带信息（registry 物化后的形态）
    expect(detectCompat({ ...m, compat: { ...p.compat, ...m.compat } })).toEqual(compat);
  });

  it("anthropic compat 缺省与覆盖", () => {
    const p = provider("anthropic");
    expect(detectAnthropicCompat(model(p, "c"), p)).toEqual({
      supportsCacheControlOnTools: true,
      supportsTemperatureWithThinking: false,
      adaptiveThinking: false,
      maxCacheBreakpoints: 4,
      sendInterleavedThinkingBeta: true,
      sendCacheControl: true,
    });
    expect(
      detectAnthropicCompat(model(p, "c", { compat: { adaptiveThinking: true } }), p)
        .adaptiveThinking,
    ).toBe(true);
  });
});
