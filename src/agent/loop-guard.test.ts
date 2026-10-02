import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../ai/types.js";
import type { ToolDefinition } from "../tools/types.js";
import {
  LoopGuard,
  REPEATED_TOOL_CALL,
  callFingerprint,
  canonicalJson,
  isPollableCall,
} from "./loop-guard.js";
import { createHarness } from "./testing/harness.js";
import { stubTool } from "./testing/stubs.js";

const call = (name: string, args: Record<string, unknown>, id = "c"): ToolCallBlock => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

describe("LoopGuard（W5-H2 H1）", () => {
  it("规范化 JSON：键顺序无关、undefined 字段省略", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined } })).toBe('{"a":{"d":[1,2]},"b":1}');
    expect(callFingerprint(call("read", { path: "a", limit: 1 }))).toBe(
      callFingerprint(call("read", { limit: 1, path: "a" })),
    );
    expect(callFingerprint(call("read", { path: "a" }))).not.toBe(
      callFingerprint(call("grep", { path: "a" })),
    );
  });

  it("同名同参累计：1–2 ok，3–4 remind，5 stop；不同参数各自计数", () => {
    const guard = new LoopGuard();
    const verdicts = [1, 2, 3, 4, 5].map(() => guard.observe(call("ls", { path: "." }), undefined));
    expect(verdicts).toEqual(["ok", "ok", "remind", "remind", "stop"]);
    expect(guard.observe(call("ls", { path: "src" }), undefined)).toBe("ok");
  });

  it("pollable 工具与后台 bash 的 wait / output 豁免；bash 普通命令不豁免", () => {
    const pollable = { annotations: { pollable: true } } as ToolDefinition;
    const guard = new LoopGuard();
    for (let i = 0; i < 8; i++) {
      expect(guard.observe(call("task_ctl", { action: "wait", taskId: "t1" }), pollable)).toBe(
        "ok",
      );
      expect(guard.observe(call("bash", { job: "j1", action: "wait" }), undefined)).toBe("ok");
    }
    expect(isPollableCall(call("bash", { job: "j1", action: "stop" }), undefined)).toBe(false);
    expect(isPollableCall(call("bash", { command: "ls" }), undefined)).toBe(false);
  });
});

describe("重复调用检测接入循环", () => {
  it("第 3、4 次结果末尾带提醒；第 5 次不执行并结束 run，agent_settled 带 repeated_tool_call", async () => {
    let runs = 0;
    const ls = stubTool({
      name: "ls",
      properties: { path: { type: "string" } },
      run: async () => {
        runs++;
        return { content: "a.txt" };
      },
    });
    const step = { toolCalls: [{ name: "ls", args: { path: "." } }] };
    const h = createHarness({
      script: [step, step, step, step, step, { text: "never" }],
      tools: [ls],
    });
    await h.session.prompt("go");
    expect(runs).toBe(4);
    expect(h.scripted.calls).toHaveLength(5);
    const results = h.session.messages.filter((m) => m.role === "toolResult");
    const texts = results.map((m) => (m.role === "toolResult" ? String(m.content) : ""));
    expect(texts[0]).toBe("a.txt");
    expect(texts[2]).toContain("called ls 3 times");
    expect(texts[3]).toContain("called ls 4 times");
    expect(texts[4]).toMatch(/^Not executed: ls was called 5 times/);
    const settled = h.events.find((e) => e.type === "agent_settled");
    expect(settled).toEqual({ type: "agent_settled", warning: REPEATED_TOOL_CALL });
  });

  it("计数按 run：新提示重新计数", async () => {
    const ls = stubTool({ name: "ls", properties: { path: { type: "string" } } });
    const step = { toolCalls: [{ name: "ls", args: { path: "." } }] };
    const h = createHarness({
      script: [step, step, { text: "a" }, step, step, { text: "b" }],
      tools: [ls],
    });
    await h.session.prompt("one");
    await h.session.prompt("two");
    const texts = h.session.messages
      .filter((m) => m.role === "toolResult")
      .map((m) => (m.role === "toolResult" ? String(m.content) : ""));
    expect(texts.every((t) => !t.includes("system-reminder"))).toBe(true);
  });
});
