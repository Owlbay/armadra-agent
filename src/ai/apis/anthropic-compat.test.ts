import { describe, expect, it } from "vitest";
import type { Model, StreamOptions, TranscriptContext, Usage } from "../types.js";
import {
  ANTHROPIC_HOST_RULES,
  DEFAULT_ANTHROPIC_COMPAT,
  detectAnthropicCompat,
  hostDefaults,
} from "./anthropic-compat.js";
import { applyAnthropicUsage } from "./anthropic-messages.js";
import { buildAnthropicRequest, INTERLEAVED_THINKING_BETA } from "./anthropic-request.js";

function model(baseUrl: string | undefined, id = "m1", extra: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    provider: "p",
    api: "anthropic-messages",
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    input: ["text"],
    reasoning: true,
    maxTokens: 32_000,
    ...extra,
  };
}

const TOOLS_CONTEXT: TranscriptContext = {
  messages: [
    {
      role: "system",
      sections: { preamble: "Be brief." },
      toolsAdded: [
        { name: "read", description: "Read", parameters: { type: "object", properties: {} } },
      ],
      timestamp: 1,
    },
    { role: "user", content: "summarize", timestamp: 2 },
  ],
};

const opts = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "sk-test",
  thinkingLevel: "medium",
  ...extra,
});

/** 请求体里 cache_control 的个数。 */
function marks(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + marks(v), 0);
  if (typeof value !== "object" || value === null) return 0;
  return Object.entries(value).reduce((n, [k, v]) => n + (k === "cache_control" ? 1 : marks(v)), 0);
}

describe("anthropic-compat 主机表真值表", () => {
  it.each<[string | undefined, string, boolean, boolean]>([
    // [baseUrl, model id, 交错思考 beta, cache_control]
    [undefined, "claude-sonnet-5", true, true],
    ["https://api.anthropic.com", "claude-sonnet-5", true, true],
    ["https://api.deepseek.com/anthropic", "deepseek-v4-pro", false, false],
    ["https://open.bigmodel.cn/api/anthropic", "glm-5.3", false, true],
    ["https://api.z.ai/api/anthropic", "glm-5.3", false, true],
    ["https://api.moonshot.cn/anthropic", "kimi-k3", false, true],
    ["https://api.moonshot.ai/anthropic", "kimi-k3", false, true],
    ["https://dashscope.aliyuncs.com/apps/anthropic", "qwen3.8-max", false, true],
    ["https://dashscope-intl.aliyuncs.com/apps/anthropic", "qwen3.8-max", false, true],
    ["https://api.minimax.cn/anthropic", "MiniMax-M3", false, true],
    ["https://api.minimax.io/anthropic", "MiniMax-M3", false, true],
    ["https://api.stepfun.com", "step-5-preview", false, true],
    ["https://tokenhub.tencentmaas.com", "hy4-preview", false, true],
    ["https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5", true, true],
    ["https://openrouter.ai/api/v1", "moonshotai/kimi-k3", false, true],
    // 未知主机（中转）：只有 claude 模型带交错思考
    ["https://www.packyapi.com", "claude-sonnet-5", true, true],
    ["https://www.packyapi.com", "kimi-k3", false, true],
    ["not a url", "claude-x", true, true],
  ])("%s · %s", (baseUrl, id, beta, cacheControl) => {
    const compat = hostDefaults(baseUrl, id);
    expect(compat.sendInterleavedThinkingBeta).toBe(beta);
    expect(compat.sendCacheControl).toBe(cacheControl);
    expect(compat.adaptiveThinking).toBe(false);
  });

  it("显式 compat 胜过主机推断；provider.compat 也生效", () => {
    const deepseek = model("https://api.deepseek.com/anthropic", "d", {
      compat: { sendCacheControl: true, sendInterleavedThinkingBeta: true },
    });
    expect(detectAnthropicCompat(deepseek)).toMatchObject({
      sendCacheControl: true,
      sendInterleavedThinkingBeta: true,
    });
    const relay = model("https://relay.example", "kimi");
    const provider = {
      id: "p",
      name: "p",
      api: "anthropic-messages" as const,
      baseUrl: "https://relay.example",
      envKeys: [],
      models: [],
      requiresApiKey: true,
      builtin: false,
      compat: { sendInterleavedThinkingBeta: true },
    };
    expect(detectAnthropicCompat(relay, provider).sendInterleavedThinkingBeta).toBe(true);
    expect(Object.keys(detectAnthropicCompat(relay)).sort()).toEqual(
      Object.keys(DEFAULT_ANTHROPIC_COMPAT).sort(),
    );
  });

  it("表里没有重复的主机子串", () => {
    const hosts = ANTHROPIC_HOST_RULES.map((r) => r.host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});

describe("请求快照：beta 头与 cache_control", () => {
  it("官方 Claude（预算型思考 + 工具）带交错思考 beta 与断点", () => {
    const req = buildAnthropicRequest(model(undefined, "claude-sonnet-4-5"), TOOLS_CONTEXT, opts());
    expect(req.betas).toEqual([INTERLEAVED_THINKING_BETA]);
    expect(marks(req.body)).toBe(3);
  });

  it("DeepSeek：不带 beta、不打 cache_control，thinking 照发", () => {
    const req = buildAnthropicRequest(
      model("https://api.deepseek.com/anthropic", "deepseek-v4-pro"),
      TOOLS_CONTEXT,
      opts(),
    );
    expect(req.betas).toEqual([]);
    expect(marks(req.body)).toBe(0);
    expect(req.body["thinking"]).toMatchObject({ type: "enabled" });
  });

  it("通义 Messages：不带 beta、照打断点", () => {
    const req = buildAnthropicRequest(
      model("https://dashscope.aliyuncs.com/apps/anthropic", "qwen3.8-max"),
      TOOLS_CONTEXT,
      opts(),
    );
    expect(req.betas).toEqual([]);
    expect(marks(req.body)).toBe(3);
  });

  it("中转上的 Claude 仍带 beta；中转上的其它模型不带", () => {
    const claude = buildAnthropicRequest(
      model("https://relay.example", "claude-sonnet-4-5"),
      TOOLS_CONTEXT,
      opts(),
    );
    const kimi = buildAnthropicRequest(
      model("https://relay.example", "kimi-k3"),
      TOOLS_CONTEXT,
      opts(),
    );
    expect(claude.betas).toEqual([INTERLEAVED_THINKING_BETA]);
    expect(kimi.betas).toEqual([]);
  });
});

describe("OpenRouter：流式 usage 只在 message_delta", () => {
  it("message_start 没有缓存字段、message_delta 才给全：合并后读到缓存", () => {
    const usage: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as Usage;
    applyAnthropicUsage(usage, { input_tokens: 0, output_tokens: 1 });
    expect(usage.cacheReported).toBe(false);
    applyAnthropicUsage(usage, {
      input_tokens: 12,
      output_tokens: 40,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
    });
    expect(usage).toMatchObject({ input: 12, output: 40, cacheRead: 9000, cacheReported: true });
  });
});

describe("请求快照：TTL（按主机缓存能力）", () => {
  const ttls = (baseUrl: string): unknown[] => {
    const body = buildAnthropicRequest(
      model(baseUrl, "x", { reasoning: false }),
      TOOLS_CONTEXT,
      opts({ cacheRetention: "long" }),
    ).body;
    const found: unknown[] = [];
    JSON.stringify(body, (key, value: unknown) => {
      if (key === "cache_control") found.push((value as { ttl?: unknown }).ttl);
      return value;
    });
    return found;
  };

  it("long：腾讯 TokenHub 带 1h，通义降为 5m，DeepSeek 不打断点", () => {
    expect(ttls("https://tokenhub.tencentmaas.com")).toEqual(["1h", "1h", "1h"]);
    expect(ttls("https://dashscope.aliyuncs.com/apps/anthropic")).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(ttls("https://api.deepseek.com/anthropic")).toEqual([]);
  });
});
