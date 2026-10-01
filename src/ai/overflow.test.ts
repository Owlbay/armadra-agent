import { describe, expect, it } from "vitest";
import { isContextOverflow, isLengthStop, isOverflowErrorText } from "./overflow.js";
import type { AssistantMessage } from "./types.js";

function msg(extra: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "x",
    provider: "p",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "error",
    timestamp: 0,
    ...extra,
  };
}

describe("overflow", () => {
  it.each([
    "400 invalid_request_error: prompt is too long: 213462 tokens > 200000 maximum",
    "413 request_too_large: Request exceeds the maximum size",
    "400 Your input exceeds the context window of this model",
    "400 invalid_request_error: This model's maximum context length is 131072 tokens.",
    "Requested token count exceeds the model's maximum context length of 131072 tokens",
    "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
    "400 INVALID_ARGUMENT: The request exceeds the maximum number of tokens allowed (1048576).",
    "context_length_exceeded: Your input exceeds the context window of this model.",
    "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
    "Please reduce the length of the messages or completion",
    "Prompt contains 140000 tokens and is too large for model with 131072 maximum context length",
    "Your request exceeded model token limit: 262144 (requested: 270000)",
    '{"code":"1261","message":"Prompt too long"}',
    "Range of input length should be [1, 129024]",
    "tokens to keep from the initial prompt is greater than the context length",
    "the request exceeds the available context size, try increasing it",
    "context_length_exceeded",
    "model_context_window_exceeded: prompt is too long",
  ])("溢出：%s", (text) => {
    expect(isOverflowErrorText(text)).toBe(true);
  });

  it.each([
    "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
    "Too many requests: too many tokens, please wait",
    "500 api_error: Internal server error",
    "429 RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details.",
    "Stream ended before completion",
  ])("非溢出：%s", (text) => {
    expect(isOverflowErrorText(text)).toBe(false);
  });

  it("消息级：error 文案、静默溢出、length 停止", () => {
    expect(isContextOverflow(msg({ errorMessage: "prompt is too long" }))).toBe(true);
    expect(
      isContextOverflow(msg({ stopReason: "aborted", errorMessage: "prompt is too long" })),
    ).toBe(false);
    const silent = msg({
      stopReason: "stop",
      usage: { input: 900, cacheRead: 200, output: 1, cacheWrite: 0, totalTokens: 0 },
    });
    expect(isContextOverflow(silent, 1000)).toBe(true);
    expect(isContextOverflow(silent)).toBe(false);
    expect(isLengthStop(msg({ stopReason: "length" }))).toBe(true);
    expect(
      isLengthStop(
        msg({
          stopReason: "length",
          content: [{ type: "toolCall", id: "a", name: "b", arguments: {} }],
        }),
      ),
    ).toBe(false);
  });
});
