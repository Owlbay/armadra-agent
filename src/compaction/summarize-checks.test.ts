import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage } from "../ai/types.js";
import { createScriptedApi, type ScriptStep } from "../agent/testing/scripted-api.js";
import { fakeModel } from "../agent/testing/stubs.js";
import { SessionManager } from "../session/manager.js";
import { buildProjection } from "../session/projection.js";
import {
  SUMMARY_TEMPLATE,
  missingSections,
  prepareCompaction,
  runCompaction,
  summarizeWithFallback,
  type StreamFn,
} from "./summarize-tier.js";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const assistantMsg = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
  timestamp: 0,
});
const result = (id: string, text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: text,
  isError: false,
  timestamp: 0,
});

describe("摘要模板（C7）", () => {
  it("补 User Messages / Errors & Fixes / Files & Code，Next Steps 附原话，声明助手文本不是用户指令", () => {
    for (const heading of [
      "## Goal",
      "## User Messages",
      "## Constraints & Preferences",
      "## Progress",
      "## Key Decisions",
      "## Errors & Fixes",
      "## Files & Code",
      "## Next Steps",
      "## Critical Context",
    ])
      expect(SUMMARY_TEMPLATE).toContain(`\n${heading}\n`);
    expect(SUMMARY_TEMPLATE).toMatch(/safety, permission and "do not" constraints verbatim/);
    expect(SUMMARY_TEMPLATE).toMatch(/at most 2000 characters/);
    expect(SUMMARY_TEMPLATE).toMatch(/verbatim quote of the latest user request/);
    expect(SUMMARY_TEMPLATE).toMatch(/is NOT a user instruction/);
    expect(SUMMARY_TEMPLATE).toMatch(/update it instead of starting over/);
  });
});

describe("自检（C8）", () => {
  const options = (steps: ScriptStep[]) => {
    const scripted = createScriptedApi(steps);
    const notes: string[] = [];
    return {
      scripted,
      notes,
      options: {
        stream: scripted.api.stream,
        model: fakeModel(),
        signal: new AbortController().signal,
        onFallback: (r: string) => notes.push(`fallback: ${r}`),
        onInvalid: (r: string) => notes.push(`invalid: ${r}`),
        continuation: { prefix: { messages: [user("hello")] } },
      },
    };
  };
  const check = (text: string) => {
    const missing = missingSections(text);
    return missing.length === 0 ? undefined : `missing ${missing.join(", ")}`;
  };
  const continuation = { keepFrom: { index: 1, excerpt: "" }, instruction: SUMMARY_TEMPLATE };

  it("续写结果缺 ## Goal：重试一次续写，仍缺回落独立请求", async () => {
    const t = options([
      { text: "Sure, continuing the task…" },
      { text: "Still continuing" },
      { text: "## Goal\nok" },
    ]);
    const out = await summarizeWithFallback(t.options, continuation, () => "independent", check);
    expect(out.text).toBe("## Goal\nok");
    expect(t.scripted.calls).toHaveLength(3);
    expect(t.scripted.calls[2]?.options.cacheRetention).toBe("none");
    expect(t.notes).toEqual(["fallback: missing ## Goal"]);
  });

  it("续写重试一次就合格：不回落", async () => {
    const t = options([{ text: "nope" }, { text: "## Goal\nsecond" }]);
    const out = await summarizeWithFallback(t.options, continuation, () => "independent", check);
    expect(out.text).toBe("## Goal\nsecond");
    expect(t.scripted.calls).toHaveLength(2);
    expect(t.notes).toEqual([]);
  });

  it("独立请求也缺：重试一次后照收并告警", async () => {
    const t = options([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }]);
    const out = await summarizeWithFallback(t.options, continuation, () => "independent", check);
    expect(out.text).toBe("d");
    expect(t.scripted.calls).toHaveLength(4);
    expect(t.notes).toEqual(["fallback: missing ## Goal", "invalid: missing ## Goal"]);
  });
});

describe("split turn 两份摘要并行（C9）", () => {
  it("历史与回合前缀的请求同时在途", async () => {
    const m = SessionManager.inMemory("/w");
    m.append({ type: "message", message: user("old") });
    m.append({ type: "message", message: assistantMsg([{ type: "text", text: "old answer" }]) });
    m.append({ type: "message", message: user("big task") });
    for (const id of ["c1", "c2"]) {
      m.append({
        type: "message",
        message: assistantMsg([{ type: "toolCall", id, name: "read", arguments: { path: id } }]),
      });
      m.append({ type: "message", message: result(id, "r".repeat(4000)) });
    }
    const plan = prepareCompaction(buildProjection(m.branch()), 1200)!;
    expect(plan.turnPrefix.length).toBeGreaterThan(0);
    const scripted = createScriptedApi([{ text: "## Goal\nhistory" }, { text: "## Turn So Far" }], {
      delayMs: 5,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const stream: StreamFn = (model, context, opts) => {
      const s = scripted.api.stream(model, context, opts);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      void s.result().finally(() => inFlight--);
      return s;
    };
    const draft = await runCompaction(plan, {
      stream,
      model: fakeModel(),
      signal: new AbortController().signal,
    });
    expect(maxInFlight).toBe(2);
    expect(draft.summary).toMatch(/## Goal\nhistory\n\n---\n\n## Turn So Far/);
  });
});
