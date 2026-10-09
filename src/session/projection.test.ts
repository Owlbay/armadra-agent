/**
 * [ME-B] D4 / D5：压缩后的投影「开头只写一次」——检查点只重放对话开始前的 system，之后的补丁合成
 * 一条放在摘要后；请求的系统提示与工具表（声明顺序、首次版本）与压缩前逐字节相同，多次压缩递归成立。
 */

import { describe, expect, it } from "vitest";
import { normalizeContext, toolRemovedReminder } from "../ai/context.js";
import type { AssistantMessage, Message, SystemMessage, ToolDecl } from "../ai/types.js";
import { convertToLlm } from "../agent/transform.js";
import { SessionManager } from "./manager.js";
import {
  buildProjection,
  replaySystem,
  synthesizeSystemPatch,
  systemCheckpoint,
} from "./projection.js";

const tool = (name: string, description = name): ToolDecl => ({
  name,
  description,
  parameters: { type: "object" },
});
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  stopReason: "stop",
  timestamp: 2,
});
const patch = (extra: Partial<SystemMessage>): SystemMessage => ({
  role: "system",
  sections: {},
  timestamp: 3,
  ...extra,
});

/** 会话：全量 system → 若干回合（每回合前可插一条补丁）。 */
function session(patches: (SystemMessage | undefined)[]): SessionManager {
  const m = SessionManager.inMemory("/w");
  m.append({
    type: "message",
    message: {
      role: "system",
      sections: { preamble: "P", tools: "T", cwd: "C" },
      toolsAdded: [tool("read"), tool("bash")],
      timestamp: 0,
    },
  });
  patches.forEach((p, i) => {
    if (p !== undefined) m.append({ type: "message", message: p });
    m.append({ type: "message", message: user(`q${i}`) });
    m.append({ type: "message", message: assistant(`a${i}`) });
  });
  return m;
}

function compact(m: SessionManager): void {
  const kept = m.append({ type: "message", message: user("kept") });
  m.append({ type: "message", message: assistant("kept answer") });
  m.append({ type: "compaction", summary: "S", firstKeptEntryId: kept.id, tokensBefore: 999 });
  m.append({ type: "message", message: user("after") });
}

const request = (m: SessionManager) =>
  normalizeContext({ messages: convertToLlm(buildProjection(m.branch()).messages) });
const prefix = (m: SessionManager) => {
  const n = request(m);
  return JSON.stringify({ system: n.systemPrompt, tools: n.tools });
};

describe("压缩后的 system 投影（ME D4 / D5）", () => {
  it("中途加工具、删工具、改节后压缩：系统提示与工具表不变，变化进摘要后的提醒；重放状态是最新的", () => {
    const m = session([
      undefined,
      patch({ toolsAdded: [tool("ls")] }),
      patch({ sections: { cwd: "C2" }, toolsRemoved: ["bash"] }),
    ]);
    const before = prefix(m);
    expect(JSON.parse(before).tools.map((t: ToolDecl) => t.name)).toEqual(["read", "bash", "ls"]);
    compact(m);
    expect(prefix(m)).toBe(before);
    const messages = buildProjection(m.branch()).messages;
    expect(messages.map((x) => x.role)).toEqual([
      "system",
      "compactionSummary",
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(replaySystem(messages)).toEqual({
      sections: { preamble: "P", tools: "T", cwd: "C2" },
      tools: [tool("read"), tool("ls")],
    });
    const reminder = String(request(m).messages[1]?.content);
    expect(reminder).toContain('System prompt section "cwd" was updated:\n\nC2');
    expect(reminder).toContain(toolRemovedReminder("bash"));
    // 再压缩一次：从原始条目重放，仍不变
    compact(m);
    expect(prefix(m)).toBe(before);
  });

  it("加过又删的新工具：合成补丁既加（首次声明）又删，工具表保留它、重放状态没有它", () => {
    const m = session([
      undefined,
      patch({ toolsAdded: [tool("x", "first")] }),
      patch({ toolsRemoved: ["x"] }),
      patch({ toolsAdded: [tool("y")] }),
      patch({ toolsAdded: [tool("x", "second")] }),
      patch({ toolsRemoved: ["x"] }),
    ]);
    const before = prefix(m);
    expect(JSON.parse(before).tools.map((t: ToolDecl) => [t.name, t.description])).toEqual([
      ["read", "read"],
      ["bash", "bash"],
      ["x", "first"],
      ["y", "y"],
    ]);
    compact(m);
    expect(prefix(m)).toBe(before);
    expect(replaySystem(buildProjection(m.branch()).messages)?.tools.map((t) => t.name)).toEqual([
      "read",
      "bash",
      "y",
    ]);
  });

  it("synthesizeSystemPatch：无变化 → undefined；首次声明在前、更新版本在后（只改重放状态）", () => {
    const head = { sections: { a: "1" }, tools: [tool("read")] };
    expect(synthesizeSystemPatch(head, [patch({ sections: { a: "1" } })], 5)).toBeUndefined();
    const out = synthesizeSystemPatch(
      head,
      [
        patch({ toolsAdded: [tool("ls", "v1")] }),
        patch({ toolsAdded: [tool("ls", "v2"), tool("read", "r2")] }),
      ],
      5,
    );
    expect(out?.toolsAdded?.map((t) => [t.name, t.description])).toEqual([
      ["ls", "v1"],
      ["read", "r2"],
      ["ls", "v2"],
    ]);
    expect(out?.timestamp).toBe(5);
    expect(replaySystem([systemCheckpoint(head, 0), out!])).toEqual({
      sections: { a: "1" },
      tools: [tool("read", "r2"), tool("ls", "v2")],
    });
  });

  it("对话开始前的补丁（custom_message 之前）进检查点，之后的进合成补丁", () => {
    const m = SessionManager.inMemory("/w");
    m.append({
      type: "message",
      message: { role: "system", sections: { preamble: "P" }, timestamp: 0 },
    });
    m.append({ type: "message", message: patch({ sections: { hooks: "h0" } }) });
    m.append({
      type: "custom_message",
      customType: "ama.hook_context",
      content: "c",
      display: false,
    });
    m.append({ type: "message", message: patch({ sections: { hooks: "h1" } }) });
    m.append({ type: "message", message: user("q") });
    compact(m);
    const [checkpoint, , synthesized] = buildProjection(m.branch()).messages;
    expect(checkpoint).toMatchObject({ role: "system", sections: { preamble: "P", hooks: "h0" } });
    expect(synthesized).toMatchObject({ role: "system", sections: { hooks: "h1" } });
  });
});
