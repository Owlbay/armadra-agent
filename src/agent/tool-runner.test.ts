/**
 * 工具运行器：`ToolResult.fileChange` 只随 `tool_execution_end` 走，不进 toolResult 消息（不落盘）。
 * [ACP-C] 守住 docs/acp-plan.md D6。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { createReadTool } from "../tools/read.js";
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

describe("[ME-D] 工具结果一次截到位（D11）", () => {
  const assistantFor = (call: ToolCallBlock) =>
    ({ role: "assistant", content: [call] }) as unknown as AssistantMessage;

  it("31 000 字符的 read 结果在 maxToolResultChars 30 000 下只截一次，续读行号与内容一致", async () => {
    const tmp = makeTmpDir();
    try {
      const line = "r".repeat(92);
      writeFileSync(join(tmp.dir, "big.txt"), Array.from({ length: 310 }, () => line).join("\n"));
      const call: ToolCallBlock = {
        type: "toolCall",
        id: "c1",
        name: "read",
        arguments: { path: "big.txt" },
      };
      const read = createReadTool();
      const batch = await runToolBatch(
        assistantFor(call),
        {
          getTool: (name) => (name === "read" ? (read as ToolDefinition) : undefined),
          beforeToolCall: async () => ({}),
          createToolContext: () => makeToolContext(tmp.dir),
          maxToolResultChars: 30_000,
          afterToolCall: async (_call, result) => result,
        },
        new AbortController().signal,
        async () => undefined,
      );
      const content = batch.messages[0]?.content ?? "";
      const text =
        typeof content === "string"
          ? content
          : content.map((block) => (block.type === "text" ? block.text : "")).join("");
      expect(text).toBeDefined();
      expect(text.length).toBeLessThanOrEqual(30_000);
      expect(text).not.toContain("chars omitted");
      const last = Number(/Showing lines 1-(\d+) of 310/.exec(text)?.[1]);
      expect(last).toBeGreaterThan(0);
      expect(text).toContain(`${String(last).padStart(6)}\t${line}\n\n[Showing`);
    } finally {
      tmp.cleanup();
    }
  });

  it("ToolContext 带上会话上限；宿主自己给了就不覆盖", async () => {
    const seen: (number | undefined)[] = [];
    const probe: ToolDefinition = {
      ...fakeEdit,
      name: "probe",
      async execute(_input, ctx): Promise<ToolResult> {
        seen.push(ctx.maxResultChars);
        return { content: "ok" };
      },
    };
    const call: ToolCallBlock = { type: "toolCall", id: "p1", name: "probe", arguments: {} };
    for (const ctx of [makeToolContext("/tmp"), makeToolContext("/tmp", { maxResultChars: 7 })]) {
      await runToolBatch(
        assistantFor(call),
        {
          getTool: () => probe,
          beforeToolCall: async () => ({}),
          createToolContext: () => ctx,
          maxToolResultChars: 12_345,
        },
        new AbortController().signal,
        async () => undefined,
      );
    }
    expect(seen).toEqual([12_345, 7]);
  });
});
