/**
 * B1 测试辅助：流契约断言（设计 §3.1）与黄金文件用的事件简化。两条协议与 fake 共用。
 */

import { expect } from "vitest";
import type { AssistantEvent, AssistantMessage } from "../../src/ai/types.js";

const KIND_OF: Record<string, "text" | "thinking" | "toolcall"> = {
  text_start: "text",
  text_delta: "text",
  text_end: "text",
  thinking_start: "thinking",
  thinking_delta: "thinking",
  thinking_end: "thinking",
  toolcall_start: "toolcall",
  toolcall_delta: "toolcall",
  toolcall_end: "toolcall",
};

const BLOCK_TYPE = { text: "text", thinking: "thinking", toolcall: "toolCall" } as const;

/** 逐条断言流契约；返回终止事件。 */
export function assertStreamContract(
  events: AssistantEvent[],
  final: AssistantMessage,
): Extract<AssistantEvent, { type: "done" | "error" }> {
  expect(events.length).toBeGreaterThan(0);
  const terminals = events.filter((e) => e.type === "done" || e.type === "error");
  expect(terminals, "恰好一个终止事件").toHaveLength(1);
  const last = events[events.length - 1];
  expect(last?.type === "done" || last?.type === "error", "终止事件在最后").toBe(true);
  const first = events[0];
  if (events.length > 1) expect(first?.type, "成功请求先 start").toBe("start");
  expect(events.filter((e) => e.type === "start").length).toBeLessThanOrEqual(1);

  const state = new Map<number, { kind: string; ended: boolean }>();
  for (const event of events) {
    const kind = KIND_OF[event.type];
    if (!kind || !("contentIndex" in event)) continue;
    const index = event.contentIndex;
    const block = event.partial.content[index];
    expect(block?.type, `${event.type} 指向的块类型`).toBe(BLOCK_TYPE[kind]);
    const entry = state.get(index);
    if (event.type.endsWith("_start")) {
      expect(entry, `块 ${index} 只 start 一次`).toBeUndefined();
      state.set(index, { kind, ended: false });
    } else {
      expect(entry?.kind, `块 ${index} 先 start`).toBe(kind);
      expect(entry?.ended, `块 ${index} end 之后不再有事件`).toBe(false);
      if (event.type.endsWith("_end") && entry) entry.ended = true;
    }
    if (event.type === "toolcall_end") {
      expect(typeof event.toolCall.arguments).toBe("object");
      expect(Array.isArray(event.toolCall.arguments)).toBe(false);
      expect(event.toolCall.arguments).not.toBeNull();
      expect(event.toolCall.id.length).toBeGreaterThan(0);
    }
  }
  for (const [index, entry] of state) expect(entry.ended, `块 ${index} 已配对关闭`).toBe(true);
  expect(state.size, "每个内容块都有事件").toBe(final.content.length);

  const terminal = last as Extract<AssistantEvent, { type: "done" | "error" }>;
  expect(terminal.message).toBe(final);
  if (terminal.type === "done") {
    expect(final.stopReason).toBe(terminal.reason);
    expect(final.errorMessage).toBeUndefined();
  } else {
    expect(final.stopReason).toBe(terminal.reason);
    expect(final.errorMessage?.length ?? 0).toBeGreaterThan(0);
  }
  for (const block of final.content) {
    if (block.type === "toolCall") expect(typeof block.arguments).toBe("object");
    expect(Object.keys(block).some((k) => k.startsWith("partial") || k === "index")).toBe(false);
  }
  return terminal;
}

/** 黄金文件形状：去掉 partial（每个事件都引用同一个对象）、时间戳归零。 */
export function simplifyEvents(events: AssistantEvent[]): unknown[] {
  return events.map((event) => {
    const out: Record<string, unknown> = { type: event.type };
    if ("contentIndex" in event) out["contentIndex"] = event.contentIndex;
    if ("delta" in event) out["delta"] = event.delta;
    if (event.type === "toolcall_start") {
      out["id"] = event.id;
      out["name"] = event.name;
    }
    if (event.type === "toolcall_end") out["toolCall"] = event.toolCall;
    if (event.type === "done" || event.type === "error") {
      out["reason"] = event.reason;
      out["message"] = { ...event.message, timestamp: 0 };
    }
    return out;
  });
}
