import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../ai/types.js";
import { toJsonLine, toWireEvent } from "./json-event.js";

const message: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hel" }],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
  stopReason: "stop",
  timestamp: 1,
};

describe("线上事件形状", () => {
  it("message_update 去掉累计消息与 partial，附 usage", () => {
    const wire = toWireEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "l", partial: message },
    });
    expect(wire).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "l" },
      usage: message.usage,
    });
    expect(JSON.stringify(wire)).not.toContain("partial");
  });

  it("done / error 保留最终 message；其它事件原样", () => {
    const done = toWireEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "done", reason: "stop", message },
    });
    expect(done).toMatchObject({ assistantMessageEvent: { type: "done", message } });
    const start = { type: "agent_start" } as const;
    expect(toWireEvent(start)).toBe(start);
  });

  it("[ACP-C0] tool_execution_end 不把 result.fileChange 带上线；没有时原样", () => {
    const end = {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "edit",
      isError: false,
      result: {
        content: "edited",
        details: { diff: "-a\n+b" },
        fileChange: { path: "/w/a.txt", oldText: "a\n", newText: "b\n", firstChangedLine: 1 },
      },
    } as const;
    const wire = toWireEvent(end);
    expect(wire).toEqual({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "edit",
      isError: false,
      result: { content: "edited", details: { diff: "-a\n+b" } },
    });
    expect(toJsonLine(wire)).not.toContain("fileChange");
    expect(end.result.fileChange).toBeDefined();
    const plain = { ...end, result: { content: "ok" } };
    expect(toWireEvent(plain)).toBe(plain);
  });

  it("toJsonLine：单行、转义 U+2028 / U+2029、Error 与 bigint 可序列化、图片不截断", () => {
    const data = "A".repeat(100_000);
    const line = toJsonLine({
      text: "a\u2028b\u2029c\nd",
      error: new Error("boom"),
      n: 10n,
      image: { type: "image", data, mimeType: "image/png" },
    });
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u2028");
    expect(JSON.parse(line)).toEqual({
      text: "a\u2028b\u2029c\nd",
      error: { name: "Error", message: "boom" },
      n: "10",
      image: { type: "image", data, mimeType: "image/png" },
    });
  });
});
