import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  Model,
  ProviderData,
  StreamOptions,
  TranscriptContext,
} from "../types.js";
import { BASIC_CONTEXT } from "../../../test/ai/golden.js";
import {
  buildResponsesRequest,
  detectResponsesCompat,
  encodeMessageSignature,
  parseMessageSignature,
  parseReasoningItem,
} from "./openai-responses-request.js";

type Json = Record<string, unknown>;

function model(provider: string, id: string, extra: Partial<Model> = {}): Model {
  const baseUrls: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    xai: "https://api.x.ai/v1",
  };
  return {
    id,
    name: id,
    provider,
    api: "openai-responses",
    baseUrl: baseUrls[provider] ?? "https://gw.example/v1",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
    ...extra,
  };
}

const gpt = model("openai", "gpt-5.5");

const opts = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "sk-test",
  ...extra,
});

const REASONING_ITEM = {
  id: "rs_01",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "Need the file." }],
  encrypted_content: "gAAAAB-enc",
};

function assistant(
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "toolUse",
    timestamp: 0,
    ...extra,
  };
}

const REPLAY: TranscriptContext = {
  messages: [
    {
      role: "system",
      sections: { preamble: "Be brief.", cwd: "cwd: /w" },
      toolsAdded: [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
        {
          name: "ls",
          description: "List",
          parameters: { type: "object", properties: { dir: { type: "string" } } },
        },
      ],
      timestamp: 0,
    },
    {
      role: "user",
      content: [
        { type: "text", text: "read a" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    assistant([
      {
        type: "thinking",
        thinking: "Need the file.",
        thinkingSignature: JSON.stringify(REASONING_ITEM),
      },
      {
        type: "text",
        text: "Reading.",
        textSignature: encodeMessageSignature("msg_01", "commentary"),
      },
      {
        type: "toolCall",
        id: "call_1",
        name: "read",
        arguments: { path: "a" },
        thoughtSignature: "fc_01",
      },
    ]),
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [
        { type: "text", text: "contents" },
        { type: "image", data: "SU1H", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: "thanks", timestamp: 4 },
  ],
};

describe("openai-responses-request：请求体", () => {
  it("官方端点：instructions、input items、store / include、strict、prompt_cache_key、reasoning summary", () => {
    const { body, providerThinkingLevel } = buildResponsesRequest(
      gpt,
      REPLAY,
      opts({ sessionId: "sess-1", thinkingLevel: "high" }),
    );
    expect(body["instructions"]).toBe("Be brief.\n\ncwd: /w");
    expect(body["store"]).toBe(false);
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(body["max_output_tokens"]).toBe(128_000);
    expect(body["prompt_cache_key"]).toBe("sess-1");
    expect(body["reasoning"]).toEqual({ effort: "high", summary: "auto" });
    expect(providerThinkingLevel).toBe("high");
    expect(body["tools"]).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: "function",
        name: "ls",
        description: "List",
        parameters: { type: "object", properties: { dir: { type: "string" } } },
        strict: false,
      },
    ]);
    expect(body["input"]).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "read a" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,QUJD",
          },
        ],
      },
      REASONING_ITEM,
      {
        type: "message",
        role: "assistant",
        id: "msg_01",
        status: "completed",
        content: [{ type: "output_text", text: "Reading.", annotations: [] }],
        phase: "commentary",
      },
      {
        type: "function_call",
        id: "fc_01",
        call_id: "call_1",
        name: "read",
        arguments: '{"path":"a"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "contents" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,SU1H",
          },
        ],
      },
      { role: "user", content: [{ type: "input_text", text: "thanks" }] },
    ]);
  });

  it("别的模型 / 别的协议：不回放 reasoning item 与 item id，文本退回简单形态", () => {
    const fromCompletions: TranscriptContext = {
      messages: REPLAY.messages.map((m) =>
        m.role === "assistant" ? { ...m, api: "openai-completions" } : m,
      ),
    };
    for (const [target, context] of [
      [model("openai", "gpt-5.4"), REPLAY],
      [gpt, fromCompletions],
    ] as const) {
      const input = buildResponsesRequest(target, context, opts()).body["input"] as Json[];
      expect(JSON.stringify(input)).not.toContain("rs_01");
      expect(JSON.stringify(input)).not.toContain("fc_01");
      expect(input[1]).toEqual({ role: "assistant", content: "Reading." });
      expect(input[2]).toEqual({
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: '{"path":"a"}',
      });
    }
  });

  it("模型不收图片：工具结果只发文本（附占位）", () => {
    const { body } = buildResponsesRequest(
      model("openai", "gpt-5.5", { input: ["text"] }),
      REPLAY,
      opts(),
    );
    const result = (body["input"] as Json[]).find((i) => i["type"] === "function_call_output");
    expect(result?.["output"]).toBe(
      "contents\n[image omitted: the model does not accept image input]",
    );
    expect(JSON.stringify(body)).not.toContain("input_image");
  });

  it("缓存键：cacheRetention none（摘要请求）不发；非官方端点不发", () => {
    expect(
      buildResponsesRequest(gpt, BASIC_CONTEXT, opts({ sessionId: "s", cacheRetention: "none" }))
        .body["prompt_cache_key"],
    ).toBeUndefined();
    expect(
      buildResponsesRequest(model("custom", "m"), BASIC_CONTEXT, opts({ sessionId: "s" })).body[
        "prompt_cache_key"
      ],
    ).toBeUndefined();
    expect(
      buildResponsesRequest(gpt, BASIC_CONTEXT, opts({ sessionId: "x".repeat(80) })).body[
        "prompt_cache_key"
      ],
    ).toHaveLength(64);
  });

  it("xAI：store false + encrypted_content，不要 summary；保守缺省什么都不发", () => {
    const xai = buildResponsesRequest(
      model("xai", "grok-4.7", { thinkingLevelMap: { off: null, minimal: null } }),
      BASIC_CONTEXT,
      opts({ thinkingLevel: "medium" }),
    );
    expect(xai.body["store"]).toBe(false);
    expect(xai.body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(xai.body["reasoning"]).toEqual({ effort: "medium" });
    const custom = buildResponsesRequest(
      model("custom", "m"),
      BASIC_CONTEXT,
      opts({ thinkingLevel: "low", temperature: 0.3 }),
    );
    expect(custom.body["store"]).toBeUndefined();
    expect(custom.body["include"]).toBeUndefined();
    expect(custom.body["reasoning"]).toEqual({ effort: "low" });
    expect(custom.body["temperature"]).toBe(0.3);
  });
});

describe("openai-responses-request：思考级别映射", () => {
  const sent = (m: Model, level?: StreamOptions["thinkingLevel"]): unknown => {
    const request = buildResponsesRequest(
      m,
      BASIC_CONTEXT,
      opts(level ? { thinkingLevel: level } : {}),
    );
    return [request.body["reasoning"], request.thinkingLevel, request.providerThinkingLevel];
  };

  it("off：映射表给字串才发（none），null 时钳到最低可用级别，未给则不发", () => {
    expect(sent(gpt)).toEqual([{ effort: "none" }, "off", "none"]);
    const o3 = model("openai", "o3", {
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
    });
    expect(sent(o3)).toEqual([{ effort: "low", summary: "auto" }, "low", "low"]);
    expect(sent(model("custom", "m", { thinkingLevelMap: {} }))).toEqual([
      undefined,
      "off",
      undefined,
    ]);
  });

  it("映射值优先；xhigh 只有显式映射才可用；非推理模型不发", () => {
    const mapped = model("openai", "gpt-6-sol", {
      thinkingLevelMap: { off: "none", minimal: "low", xhigh: "xhigh" },
    });
    expect(sent(mapped, "minimal")).toEqual([{ effort: "low", summary: "auto" }, "minimal", "low"]);
    expect(sent(mapped, "xhigh")).toEqual([{ effort: "xhigh", summary: "auto" }, "xhigh", "xhigh"]);
    const noX = model("openai", "gpt-5", { thinkingLevelMap: { off: null } });
    expect(sent(noX, "xhigh")).toEqual([{ effort: "high", summary: "auto" }, "high", "high"]);
    expect(sent(model("openai", "gpt-4.1", { reasoning: false }), "high")).toEqual([
      undefined,
      "off",
      undefined,
    ]);
    const plain = buildResponsesRequest(
      model("openai", "gpt-4.1", { reasoning: false }),
      BASIC_CONTEXT,
      opts(),
    );
    expect(plain.body["include"]).toBeUndefined();
    expect(plain.body["store"]).toBe(false);
  });
});

describe("签名编解码", () => {
  it("message 签名与 reasoning item", () => {
    expect(parseMessageSignature(encodeMessageSignature("msg_1"))).toEqual({ id: "msg_1" });
    expect(parseMessageSignature(encodeMessageSignature("msg_1", "final_answer"))).toEqual({
      id: "msg_1",
      phase: "final_answer",
    });
    expect(parseMessageSignature("Q2lR")).toBeUndefined();
    expect(parseMessageSignature("{bad")).toBeUndefined();
    expect(parseReasoningItem(JSON.stringify(REASONING_ITEM))).toEqual(REASONING_ITEM);
    expect(parseReasoningItem('{"type":"message","id":"x"}')).toBeUndefined();
    expect(parseReasoningItem("reasoning_content")).toBeUndefined();
  });
});

describe("detectResponsesCompat 真值表", () => {
  const provider = (
    id: string,
    baseUrl: string,
    compat?: ProviderData["compat"],
  ): ProviderData => ({
    id,
    name: id,
    api: "openai-responses",
    baseUrl,
    envKeys: [],
    models: [],
    requiresApiKey: true,
    builtin: false,
    ...(compat ? { compat } : {}),
  });
  it.each([
    [
      "openai",
      "https://api.openai.com/v1",
      undefined,
      { supportsReasoningSummary: true, supportsStore: true },
    ],
    [
      "xai",
      "https://api.x.ai/v1",
      undefined,
      { supportsReasoningSummary: false, supportsStore: true },
    ],
    [
      "my-gw",
      "https://api.openai.com/v1",
      undefined,
      { supportsReasoningSummary: true, supportsStore: true },
    ],
    [
      "my-xai",
      "https://api.x.ai/v1",
      undefined,
      { supportsReasoningSummary: false, supportsStore: true },
    ],
    [
      "custom",
      "https://gw.example/v1",
      undefined,
      { supportsReasoningSummary: false, supportsStore: false },
    ],
    [
      "custom",
      "https://gw.example/v1",
      { supportsReasoningSummary: true },
      { supportsReasoningSummary: true, supportsStore: false },
    ],
    [
      "openai",
      "https://api.openai.com/v1",
      { supportsStore: false },
      { supportsReasoningSummary: true, supportsStore: false },
    ],
  ] as const)("%s %s %j", (id, baseUrl, compat, expected) => {
    const m = model(id, "m", { baseUrl });
    expect(detectResponsesCompat(m, provider(id, baseUrl, compat))).toEqual(expected);
  });

  it("model.compat 覆盖 provider.compat", () => {
    const m = model("openai", "m", { compat: { supportsReasoningSummary: false } });
    expect(
      detectResponsesCompat(
        m,
        provider("openai", "https://api.openai.com/v1", { supportsReasoningSummary: true }),
      ),
    ).toEqual({ supportsReasoningSummary: false, supportsStore: true });
  });
});
