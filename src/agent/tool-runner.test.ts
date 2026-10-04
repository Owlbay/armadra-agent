/**
 * 工具运行器：`ToolResult.fileChange` 只随 `tool_execution_end` 走，不进 toolResult 消息（不落盘）。
 * [ACP-C] 守住 docs/acp-plan.md D6。
 */

import { describe, expect, it } from "vitest";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import type { AssistantMessage, ToolCallBlock } from "../ai/types.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import type { SessionEvent } from "./types.js";
import { runToolBatch, toolResultMessage } from "./tool-runner.js";

const change = { path: "/tmp/a.txt", oldText: "old\n", newText: "new\n", firstChangedLine: 1 };

const fakeEdit: ToolDefinition = {
  name: "edit",
  label: "Edit",
  description: "test",
  parameters: { type: "object", properties: {} },
  permission: "write",
  async execute(): Promise<ToolResult> {
    return { content: "Edited a.txt", details: { diff: "-old\n+new" }, fileChange: change };
  },
};

describe("tool-runner 与 fileChange", () => {
  it("toolResultMessage 只拷 details，不带 fileChange", () => {
    const call: ToolCallBlock = { type: "toolCall", id: "c1", name: "edit", arguments: {} };
    const message = toolResultMessage(call, {
      content: "ok",
      details: { a: 1 },
      fileChange: change,
    });
    expect(message.details).toEqual({ a: 1 });
    expect(message).not.toHaveProperty("fileChange");
  });

  it("runToolBatch：tool_execution_end 带 fileChange，toolResult 消息与 message_end 不带", async () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "edit", arguments: {} }],
    } as unknown as AssistantMessage;
    const events: SessionEvent[] = [];
    const batch = await runToolBatch(
      assistant,
      {
        getTool: (name) => (name === "edit" ? fakeEdit : undefined),
        beforeToolCall: async () => ({}),
        createToolContext: () => makeToolContext("/tmp"),
      },
      new AbortController().signal,
      async (event) => void events.push(event),
    );
    const end = events.find((e) => e.type === "tool_execution_end");
    expect(end?.type === "tool_execution_end" ? end.result.fileChange : undefined).toEqual(change);
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0]).not.toHaveProperty("fileChange");
    expect(JSON.stringify(batch.messages)).not.toContain("new\\n");
    const ended = events.filter((e) => e.type === "message_end");
    expect(JSON.stringify(ended)).not.toContain("fileChange");
  });
});
