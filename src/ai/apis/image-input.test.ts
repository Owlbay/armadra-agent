/**
 * 用户消息里的图片在四条协议上的映射（docs/providers.md「图像输入」）：同一条带图的 user 消息，
 * 各协议的请求体里都出现对应形状；模型 input 不含 image 时换成占位文字。
 */

import { describe, expect, it } from "vitest";
import type { Api, Model, StreamOptions, TranscriptContext } from "../types.js";
import { buildAnthropicRequest } from "./anthropic-request.js";
import { buildGoogleRequest } from "./google-request.js";
import { buildOpenAIRequest } from "./openai-request.js";
import { buildResponsesRequest } from "./openai-responses-request.js";

const DATA = "iVBORw0KGgo=";

const CONTEXT: TranscriptContext = {
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "图里有什么颜色" },
        { type: "image", mimeType: "image/png", data: DATA },
      ],
      timestamp: 0,
    },
  ],
};

function model(api: Api, image = true): Model {
  return {
    id: "vl",
    name: "vl",
    provider: "relay",
    api,
    baseUrl: "https://relay.example/v1",
    input: image ? ["text", "image"] : ["text"],
    reasoning: false,
    maxTokens: 1024,
  };
}

const OPTIONS = { signal: new AbortController().signal } as StreamOptions;

function body(api: Api, image = true): string {
  const m = model(api, image);
  switch (api) {
    case "openai-completions":
      return JSON.stringify(buildOpenAIRequest(m, CONTEXT, OPTIONS).body);
    case "openai-responses":
      return JSON.stringify(buildResponsesRequest(m, CONTEXT, OPTIONS).body);
    case "anthropic-messages":
      return JSON.stringify(buildAnthropicRequest(m, CONTEXT, OPTIONS).body);
    default:
      return JSON.stringify(buildGoogleRequest(m, CONTEXT, OPTIONS).body);
  }
}

describe("用户消息图片的协议映射", () => {
  it("Chat Completions：image_url（data URL）", () => {
    expect(body("openai-completions")).toContain(
      `{"type":"image_url","image_url":{"url":"data:image/png;base64,${DATA}"}}`,
    );
  });

  it("Responses：input_image", () => {
    expect(body("openai-responses")).toContain(
      `"type":"input_image","detail":"auto","image_url":"data:image/png;base64,${DATA}"`,
    );
  });

  it("Anthropic Messages：image + base64 source", () => {
    expect(body("anthropic-messages")).toContain(
      `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${DATA}"}`,
    );
  });

  it("Gemini：inlineData", () => {
    expect(body("google-generative-ai")).toContain(
      `{"inlineData":{"mimeType":"image/png","data":"${DATA}"}}`,
    );
  });

  it("模型不收图片：四条协议都不发图片数据", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
    ] as const) {
      const text = body(api, false);
      expect(text).not.toContain(DATA);
      expect(text).toContain("image omitted");
    }
  });
});
