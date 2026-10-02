/**
 * 嵌套调用（ToolContext.tools.executeTool）：codemode 脚本里的 tools.* 走完整门禁、按全部工具查找、
 * 发带 parentToolCallId 的事件，Hook 输入带 viaCodemode / parentToolCallId（设计 §5.5）。
 */

import { describe, expect, it } from "vitest";
import type { ToolResult } from "../tools/types.js";
import { createHarness } from "./testing/harness.js";
import { stubHooks, stubPermission, stubTool } from "./testing/stubs.js";
import type { SessionEvent } from "./types.js";

function outer(name: string, calls: { name: string; input: unknown }[], signal?: AbortSignal) {
  return stubTool({
    name,
    permission: "execute",
    run: async (_input, ctx) => {
      const results: ToolResult[] = await Promise.all(
        calls.map((c) =>
          ctx.tools.executeTool(c.name, c.input, signal === undefined ? {} : { signal }),
        ),
      );
      return {
        content: results
          .map((r) => `${r.isError === true ? "ERR" : "OK"} ${String(r.content)}`)
          .join("\n"),
      };
    },
  });
}

const script = [{ toolCalls: [{ name: "codemode", args: {}, id: "cm1" }] }, { text: "done" }];

describe("嵌套调用", () => {
  it("按全部工具查找（活动集只有 codemode）；事件带 parentToolCallId，不入转录", async () => {
    const h = createHarness({
      script,
      tools: [
        outer("codemode", [
          { name: "read", input: { path: "a" } },
          { name: "grep", input: {} },
        ]),
        stubTool({ name: "read", run: (input) => ({ content: `read ${String(input["path"])}` }) }),
        stubTool({ name: "grep" }),
      ],
      activeTools: ["codemode"],
    });
    await h.session.prompt("go");
    const toolEvents = h.events.filter((e): e is Extract<SessionEvent, { toolCallId: string }> =>
      e.type.startsWith("tool_execution_"),
    );
    const nested = toolEvents.filter((e) => e.parentToolCallId === "cm1");
    expect(nested.map((e) => `${e.type}:${e.toolName}`).sort()).toEqual([
      "tool_execution_end:grep",
      "tool_execution_end:read",
      "tool_execution_start:grep",
      "tool_execution_start:read",
    ]);
    expect(nested.every((e) => /^cm1_n\d$/.test(e.toolCallId))).toBe(true);
    const outerEvents = toolEvents.filter((e) => e.toolCallId === "cm1");
    expect(outerEvents.map((e) => e.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
    expect(outerEvents.every((e) => e.parentToolCallId === undefined)).toBe(true);
    // 外层 start 在内层之前、外层 end 在内层之后
    const order = toolEvents.map((e) => `${e.type}:${e.toolCallId}`);
    expect(order[0]).toBe("tool_execution_start:cm1");
    expect(order.at(-1)).toBe("tool_execution_end:cm1");
    const results = h.session.messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => m.toolCallId)).toEqual(["cm1"]);
    expect(String(results[0]?.content)).toBe("OK read a\nOK grep ok");
  });

  it("Hook 输入：内层带 viaCodemode:true 与父 toolCallId，按真实工具名匹配；外层不带", async () => {
    const hooks = stubHooks({ PreToolUse: () => undefined, PostToolUse: () => undefined });
    const h = createHarness({
      script,
      hooks,
      tools: [outer("codemode", [{ name: "read", input: {} }]), stubTool({ name: "read" })],
      activeTools: ["codemode"],
    });
    await h.session.prompt("go");
    const pre = hooks.calls.filter((c) => c.event === "PreToolUse").map((c) => c.payload);
    expect(pre).toEqual([
      { toolCallId: "cm1", toolName: "codemode", toolInput: {} },
      {
        toolCallId: "cm1_n1",
        toolName: "read",
        toolInput: {},
        viaCodemode: true,
        parentToolCallId: "cm1",
      },
    ]);
    const post = hooks.calls.filter((c) => c.event === "PostToolUse").map((c) => c.payload);
    expect(post.find((p) => p.toolName === "read")).toMatchObject({
      viaCodemode: true,
      parentToolCallId: "cm1",
    });
    expect(post.find((p) => p.toolName === "codemode")?.viaCodemode).toBeUndefined();
  });

  it("其它工具发起的嵌套调用只带 parentToolCallId，不带 viaCodemode", async () => {
    const hooks = stubHooks({ PreToolUse: () => undefined });
    const h = createHarness({
      script: [{ toolCalls: [{ name: "wrapper", args: {}, id: "w1" }] }, { text: "done" }],
      hooks,
      tools: [outer("wrapper", [{ name: "read", input: {} }]), stubTool({ name: "read" })],
    });
    await h.session.prompt("go");
    const inner = hooks.calls.find((c) => c.payload.toolName === "read")?.payload;
    expect(inner).toMatchObject({ parentToolCallId: "w1" });
    expect(inner?.viaCodemode).toBeUndefined();
  });

  it("内层被权限管线拒绝 → 错误结果，其余照常；未知工具报 not found", async () => {
    const h = createHarness({
      script,
      permission: stubPermission((input) =>
        input.toolName === "bash"
          ? { decision: "deny", step: "deny-rule", message: "bash denied by rule" }
          : undefined,
      ),
      tools: [
        outer("codemode", [
          { name: "bash", input: {} },
          { name: "read", input: {} },
          { name: "nope", input: {} },
        ]),
        stubTool({ name: "bash", permission: "execute" }),
        stubTool({ name: "read" }),
      ],
      activeTools: ["codemode"],
    });
    await h.session.prompt("go");
    const result = h.session.messages.find((m) => m.role === "toolResult");
    expect(String(result?.content)).toBe(
      "ERR bash denied by rule\nOK read ok\nERR Tool nope not found",
    );
    const ends = h.events.filter(
      (e): e is Extract<SessionEvent, { type: "tool_execution_end" }> =>
        e.type === "tool_execution_end" && e.parentToolCallId === "cm1",
    );
    expect(ends.map((e) => `${e.toolName}:${e.isError}`).sort()).toEqual([
      "bash:true",
      "nope:true",
      "read:false",
    ]);
  });

  it("executeTool 的 signal：取消单次嵌套调用而不影响外层", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const h = createHarness({
      script,
      tools: [
        outer("codemode", [{ name: "read", input: {} }], cancel.signal),
        stubTool({ name: "read" }),
      ],
      activeTools: ["codemode"],
    });
    await h.session.prompt("go");
    const result = h.session.messages.find((m) => m.role === "toolResult");
    expect(String(result?.content)).toBe("ERR aborted by user");
    expect(result?.isError).toBe(false);
  });

  it("嵌套结果给脚本：截断上限放宽，不按 maxToolResultChars 截", async () => {
    const big = "x".repeat(5000);
    const h = createHarness({
      script,
      maxToolResultChars: 100_000,
      tools: [
        stubTool({
          name: "codemode",
          permission: "execute",
          run: async (_input, ctx) => {
            const r = await ctx.tools.executeTool("read", {});
            return { content: String((r.content as string).length) };
          },
        }),
        stubTool({ name: "read", run: () => ({ content: big }) }),
      ],
      activeTools: ["codemode"],
    });
    await h.session.prompt("go");
    expect(String(h.session.messages.find((m) => m.role === "toolResult")?.content)).toBe("5000");
  });
});
