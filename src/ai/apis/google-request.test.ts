import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model, StreamOptions, TranscriptContext } from "../types.js";
import { BASIC_CONTEXT } from "../../../test/ai/golden.js";
import {
  buildGoogleRequest,
  detectGoogleCompat,
  geminiMajorVersion,
  toGoogleSchema,
  usesDiscreteThinkingLevel,
} from "./google-request.js";

type Json = Record<string, unknown>;

function gemini(id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    provider: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    ...extra,
  };
}

const opts = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "k",
  ...extra,
});

const SIG = "c2lnLW9uZQ==";
const SIG2 = "c2lnLXR3bw==";

function assistant(
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "google-generative-ai",
    provider: "google",
    model: "gemini-3.1-pro-preview",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "toolUse",
    timestamp: 0,
    ...extra,
  };
}

const TOOL_CONTEXT: TranscriptContext = {
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
            properties: {
              path: { type: "string" },
              opts: { type: "object", properties: {}, additionalProperties: false },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      timestamp: 0,
    },
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    assistant([
      { type: "thinking", thinking: "plan", thinkingSignature: SIG },
      {
        type: "toolCall",
        id: "c1",
        name: "read",
        arguments: { path: "a" },
        thoughtSignature: SIG2,
      },
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [
        { type: "text", text: "A" },
        { type: "image", data: "SU1H", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "read",
      content: "no such file",
      isError: true,
      timestamp: 4,
    },
    assistant([{ type: "text", text: "", textSignature: SIG }], { stopReason: "stop" }),
    { role: "user", content: "thanks", timestamp: 5 },
  ],
};

describe("google-request：请求体", () => {
  it("contents：角色、systemInstruction、工具声明、签名回放、工具结果合并与内嵌图片（Gemini 3）", () => {
    const { body } = buildGoogleRequest(
      gemini("gemini-3.1-pro-preview"),
      TOOL_CONTEXT,
      opts({ thinkingLevel: "low" }),
    );
    expect(body["systemInstruction"]).toEqual({ parts: [{ text: "Be brief.\n\ncwd: /w" }] });
    expect(body["tools"]).toEqual([
      {
        functionDeclarations: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" }, opts: { type: "object", properties: {} } },
              required: ["path"],
            },
          },
        ],
      },
    ]);
    const contents = body["contents"] as Json[];
    expect(contents.map((c) => c["role"])).toEqual(["user", "model", "user", "model", "user"]);
    expect(contents[0]).toEqual({
      role: "user",
      parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }],
    });
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        { thought: true, text: "plan", thoughtSignature: SIG },
        { functionCall: { name: "read", args: { path: "a" }, id: "c1" }, thoughtSignature: SIG2 },
        { functionCall: { name: "read", args: { path: "b" }, id: "c2" } },
      ],
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "read",
            response: { output: "A" },
            parts: [{ inlineData: { mimeType: "image/png", data: "SU1H" } }],
            id: "c1",
          },
        },
        { functionResponse: { name: "read", response: { error: "no such file" }, id: "c2" } },
      ],
    });
    // 空文本 part 带签名也要送回
    expect(contents[3]).toEqual({ role: "model", parts: [{ text: "", thoughtSignature: SIG }] });
    expect(body["generationConfig"]).toEqual({
      maxOutputTokens: 65_536,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" },
    });
  });

  it("Gemini 2.5：工具调用不带 id，工具结果图片另起 user 回合", () => {
    const model = gemini("gemini-2.5-flash");
    const ctx: TranscriptContext = {
      messages: TOOL_CONTEXT.messages.map((m) =>
        m.role === "assistant" ? { ...m, model: "gemini-2.5-flash" } : m,
      ),
    };
    const contents = buildGoogleRequest(model, ctx, opts()).body["contents"] as Json[];
    expect(JSON.stringify(contents)).not.toContain('"id"');
    expect(contents.map((c) => c["role"])).toEqual([
      "user",
      "model",
      "user",
      "user",
      "model",
      "user",
    ]);
    expect(contents[3]).toEqual({
      role: "user",
      parts: [
        { text: "Tool result images:" },
        { inlineData: { mimeType: "image/png", data: "SU1H" } },
      ],
    });
  });

  it("签名只回放给同 provider / 同模型、合法 base64；别家思考降级为文本", () => {
    const other = buildGoogleRequest(gemini("gemini-3.8-flash"), TOOL_CONTEXT, opts());
    const contents = other.body["contents"] as Json[];
    expect(JSON.stringify(contents)).not.toContain("thoughtSignature");
    expect(contents[1]?.["parts"]).toEqual([
      { text: "plan" },
      { functionCall: { name: "read", args: { path: "a" }, id: "c1" } },
      { functionCall: { name: "read", args: { path: "b" }, id: "c2" } },
    ]);
    // 空文本且签名不可用 → 整条助手消息为空，跳过
    expect(contents.map((c) => c["role"])).toEqual(["user", "model", "user", "user"]);
    const bad: TranscriptContext = {
      messages: [
        assistant([
          { type: "text", text: "x", textSignature: "not base64!" },
          { type: "thinking", thinking: "r", thinkingSignature: "abc" },
          { type: "thinking", thinking: "[redacted]", thinkingSignature: SIG, redacted: true },
        ]),
      ],
    };
    const bad3 = buildGoogleRequest(gemini("gemini-3.1-pro-preview"), bad, opts());
    expect((bad3.body["contents"] as Json[])[0]?.["parts"]).toEqual([
      { text: "x" },
      { thought: true, text: "r" },
    ]);
    const off = buildGoogleRequest(
      gemini("gemini-3.1-pro-preview", { compat: { supportsThoughtSignature: false } }),
      TOOL_CONTEXT,
      opts(),
    );
    expect(JSON.stringify(off.body)).not.toContain("thoughtSignature");
  });

  it("模型不收图片：用户图片换占位文本，工具结果图片不发", () => {
    const { body } = buildGoogleRequest(
      gemini("gemini-3.1-pro-preview", { input: ["text"] }),
      TOOL_CONTEXT,
      opts(),
    );
    expect(JSON.stringify(body)).not.toContain("inlineData");
    expect(JSON.stringify(body)).toContain("[image omitted");
  });

  it("generationConfig：temperature、maxTokens、samplingParams；非推理模型不发 thinkingConfig", () => {
    const { body, providerThinkingLevel } = buildGoogleRequest(
      gemini("gemma-3-27b-it", { reasoning: false, samplingParams: { topK: 40 } }),
      BASIC_CONTEXT,
      opts({ temperature: 0.2, maxTokens: 1000, thinkingLevel: "high" }),
    );
    expect(body["generationConfig"]).toEqual({ maxOutputTokens: 1000, temperature: 0.2, topK: 40 });
    expect(providerThinkingLevel).toBeUndefined();
  });
});

describe("google-request：思考级别映射", () => {
  const config = (model: Model, extra: Partial<StreamOptions>): unknown => {
    const request = buildGoogleRequest(model, BASIC_CONTEXT, opts(extra));
    return {
      thinking: (request.body["generationConfig"] as Json)["thinkingConfig"],
      level: request.thinkingLevel,
      sent: request.providerThinkingLevel,
    };
  };

  it("Gemini 3：映射字串 → 离散 thinkingLevel；off 为 null 时钳到最低可用级别", () => {
    const pro = gemini("gemini-3.1-pro-preview", {
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
    });
    expect(config(pro, { thinkingLevel: "medium" })).toEqual({
      thinking: { includeThoughts: true, thinkingLevel: "MEDIUM" },
      level: "medium",
      sent: "MEDIUM",
    });
    expect(config(pro, {})).toMatchObject({ level: "low", sent: "LOW" });
    expect(config(pro, { thinkingLevel: "xhigh" })).toMatchObject({ level: "high", sent: "HIGH" });
    const flash = gemini("gemini-3-flash-preview", { thinkingLevelMap: { off: null } });
    expect(config(flash, { thinkingLevel: "minimal" })).toMatchObject({ sent: "MINIMAL" });
  });

  it("Gemini 2.5：预算（映射数字优先、缺省表、回答留白、-1 动态）；off → thinkingBudget 0", () => {
    const flash = gemini("gemini-2.5-flash", {
      thinkingLevelMap: { minimal: 128, high: 24576, xhigh: null },
    });
    expect(config(flash, { thinkingLevel: "high" })).toEqual({
      thinking: { includeThoughts: true, thinkingBudget: 24576 },
      level: "high",
      sent: "24576",
    });
    expect(config(flash, { thinkingLevel: "medium" })).toMatchObject({ sent: "8192" });
    expect(config(flash, { thinkingLevel: "medium", maxTokens: 4096 })).toMatchObject({
      sent: "3072",
    });
    expect(config(flash, {})).toEqual({ thinking: { thinkingBudget: 0 }, level: "off", sent: "0" });
    const dynamic = gemini("gemini-2.5-pro", { thinkingLevelMap: { off: null, low: -1 } });
    expect(config(dynamic, { thinkingLevel: "low" })).toMatchObject({
      thinking: { includeThoughts: true, thinkingBudget: -1 },
      sent: "-1",
    });
    expect(config(dynamic, {})).toMatchObject({ level: "minimal", sent: "1024" });
  });

  it("映射值是数字时 Gemini 3 也走预算；off 映射字串 → 离散级别", () => {
    const model = gemini("gemini-3.1-pro-preview", {
      thinkingLevelMap: { off: "minimal", high: 32768 },
    });
    expect(config(model, { thinkingLevel: "high" })).toMatchObject({
      thinking: { includeThoughts: true, thinkingBudget: 32768 },
    });
    expect(config(model, {})).toMatchObject({ thinking: { thinkingLevel: "MINIMAL" } });
  });

  it("模型族与 compat 推断", () => {
    expect(geminiMajorVersion("gemini-3.1-pro-preview")).toBe(3);
    expect(geminiMajorVersion("models/gemini-2.5-flash")).toBe(2);
    expect(geminiMajorVersion("gemma-3-27b-it")).toBeUndefined();
    expect(usesDiscreteThinkingLevel("gemini-3.8-flash")).toBe(true);
    expect(usesDiscreteThinkingLevel("gemini-flash-latest")).toBe(true);
    expect(usesDiscreteThinkingLevel("gemini-2.5-pro")).toBe(false);
    expect(
      toGoogleSchema({ type: "array", items: { type: "object", additionalProperties: true } }),
    ).toEqual({ type: "array", items: { type: "object" } });
  });
});

describe("detectGoogleCompat 真值表", () => {
  const provider = {
    id: "google",
    name: "Google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKeys: [],
    models: [],
    requiresApiKey: true,
    builtin: true,
  };
  it.each([
    [
      "gemini-3.1-pro-preview",
      undefined,
      undefined,
      { supportsThoughtSignature: true, supportsFunctionResponseParts: true },
    ],
    [
      "gemini-2.5-pro",
      undefined,
      undefined,
      { supportsThoughtSignature: true, supportsFunctionResponseParts: false },
    ],
    [
      "gemma-4-31b-it",
      undefined,
      undefined,
      { supportsThoughtSignature: true, supportsFunctionResponseParts: false },
    ],
    [
      "gemini-3-flash-preview",
      { supportsThoughtSignature: false },
      undefined,
      { supportsThoughtSignature: false, supportsFunctionResponseParts: true },
    ],
    [
      "gemini-2.5-flash",
      { supportsFunctionResponseParts: true },
      { supportsFunctionResponseParts: false },
      { supportsThoughtSignature: true, supportsFunctionResponseParts: false },
    ],
  ] as const)("%s provider=%j model=%j", (id, providerCompat, modelCompat, expected) => {
    const model = gemini(id, modelCompat ? { compat: modelCompat } : {});
    const data = providerCompat ? { ...provider, compat: providerCompat } : provider;
    expect(detectGoogleCompat(model, data)).toEqual(expected);
  });
});
