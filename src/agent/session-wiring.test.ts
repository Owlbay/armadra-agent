/**
 * 组装根（B6）依赖的 B2 接缝：before_agent_start、子 Agent 的 Hook 公共字段与审批上下文、
 * 缓存命中率统计。
 */

import { describe, expect, it } from "vitest";
import type { HookContextOverrides, HookEvent } from "../hooks/types.js";
import type { ApprovalRequest } from "../permissions/types.js";
import { cacheHitRate } from "./session-state.js";
import { createHarness, userTexts } from "./testing/harness.js";
import { stubHooks, stubPermission, stubTool } from "./testing/stubs.js";

describe("before_agent_start", () => {
  it("在 UserPromptSubmit 之后、agent_start 之前发，带展开后的提示", async () => {
    const h = createHarness({
      script: [{ text: "ok" }],
      hooks: stubHooks({ UserPromptSubmit: () => ({ updatedPrompt: "rewritten" }) }),
      expandPrompt: async (text) => ({ text: `${text}!` }),
    });
    await h.session.prompt("hi");
    const types = h.types();
    const at = types.indexOf("before_agent_start");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(types.indexOf("agent_start"));
    expect(h.events[at]).toEqual({ type: "before_agent_start", prompt: "rewritten" });
  });
});

describe("子 Agent", () => {
  function delegating(options: Parameters<typeof createHarness>[0]) {
    const task = stubTool({
      name: "task",
      permission: "execute",
      run: async (_input, ctx) => {
        const sub = await ctx.spawnSubagent!({
          prompt: "sub job",
          parentToolCallId: ctx.toolCallId,
          signal: ctx.signal,
        });
        return { content: sub.text, isError: sub.isError };
      },
    });
    return createHarness({ ...options, tools: [task, ...(options.tools ?? [])] });
  }

  it("Hook 公共字段按会话覆盖：子会话 depth 1、自己的 sessionId", async () => {
    const contexts: { event: HookEvent; context: HookContextOverrides | undefined }[] = [];
    const hooks = stubHooks({ UserPromptSubmit: () => undefined });
    const run = hooks.run.bind(hooks);
    hooks.run = (event, payload, signal, context) => {
      contexts.push({ event, context });
      return run(event, payload, signal, context);
    };
    const h = delegating({
      hooks,
      script: (call) =>
        userTexts(call.context)[0] === "sub job"
          ? { text: "child" }
          : call.context.messages.at(-1)?.role === "toolResult"
            ? { text: "done" }
            : { toolCalls: [{ name: "task", args: {} }] },
    });
    await h.session.prompt("go");
    const [parent, child] = contexts.map((c) => c.context);
    expect(parent).toMatchObject({ depth: 0, sessionId: h.manager.id });
    expect(child?.depth).toBe(1);
    expect(child?.sessionId).not.toBe(h.manager.id);
  });

  it("审批请求带 context.depth 与 parentToolCallId，事件转发到父会话", async () => {
    const asked: ApprovalRequest[] = [];
    const write = stubTool({ name: "write", permission: "write" });
    const h = delegating({
      tools: [write],
      permission: stubPermission((input) =>
        input.toolName === "write"
          ? { decision: "ask", step: "mode", approvalReason: "mode" }
          : undefined,
      ),
      brokers: [{ ask: async (request) => (asked.push(request), "allow") }],
      script: (call) => {
        const last = call.context.messages.at(-1);
        if (userTexts(call.context)[0] === "sub job") {
          return last?.role === "toolResult"
            ? { text: "child" }
            : { toolCalls: [{ name: "write", args: {} }] };
        }
        return last?.role === "toolResult"
          ? { text: "done" }
          : { toolCalls: [{ name: "task", args: {} }] };
      },
    });
    await h.session.prompt("go");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.context?.depth).toBe(1);
    expect(asked[0]?.context?.parentToolCallId).toBeDefined();
    const forwarded = h.events.filter((e) => e.type === "permission_request");
    expect(forwarded).toHaveLength(1);
    expect(h.events.some((e) => e.type === "permission_resolved")).toBe(true);
  });
});

describe("缓存命中率", () => {
  it("cacheRead /（input + cacheRead + cacheWrite）；无用量 undefined", async () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    expect(cacheHitRate({ input: 100, cacheRead: 800, cacheWrite: 100 })).toBe(0.8);
    const h = createHarness({
      script: [{ text: "a", usage: { input: 100, output: 1, cacheRead: 300, cacheWrite: 0 } }],
    });
    expect(h.session.getStats().cacheHitRate).toBeUndefined();
    await h.session.prompt("x");
    expect(h.session.getStats().cacheHitRate).toBe(0.75);
  });
});
