/**
 * AcpEventMapper：直接喂 SessionEvent 序列，断言发出的 `session/update`（docs/acp-plan.md §2.3、[ACP-C]）。
 * 每条更新都按官方 schema 的 `SessionNotification` 校验。
 */

import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import { validateAcp } from "../../../test/helpers/acp-schema.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import type {
  AcpAvailableCommand,
  AcpSessionConfigOption,
  AcpSessionUpdate,
} from "../../drivers/acp/types.js";
import type { AgentMessage } from "../../session/types.js";
import type { ToolResult } from "../../tools/types.js";
import { msg } from "../../i18n/index.js";
import { AcpEventMapper, permissionModes, TOOL_OUTPUT_LIMIT } from "./acp-events.js";

let h: ComposeHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const CWD = "/work";

const CONFIG: AcpSessionConfigOption[] = [
  {
    id: "thinking",
    name: "Thinking level",
    type: "select",
    category: "thought_level",
    currentValue: "high",
    options: [
      { value: "low", name: "low" },
      { value: "high", name: "high" },
    ],
  } as AcpSessionConfigOption,
];
const COMMANDS: AcpAvailableCommand[] = [{ name: "skill:review", description: "Review code" }];

function mapper(stats: () => Record<string, unknown> = () => ({})): {
  m: AcpEventMapper;
  out: AcpSessionUpdate[];
} {
  const out: AcpSessionUpdate[] = [];
  const session = { getStats: stats } as unknown as AgentSession;
  const m = new AcpEventMapper(
    CWD,
    (u) => out.push(u),
    () => session,
    () => ({ configOptions: CONFIG, commands: COMMANDS }),
  );
  return { m, out };
}

/** 每条更新都按 schema 校验（SessionNotification 包一层）。 */
function expectValid(out: readonly AcpSessionUpdate[]): void {
  for (const update of out)
    expect(
      validateAcp("SessionNotification", { sessionId: "s", update }),
      JSON.stringify(update),
    ).toEqual([]);
}

const toolcallEnd = (id: string, name: string, args: Record<string, unknown>): SessionEvent =>
  ({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id, name, arguments: args },
    },
  }) as unknown as SessionEvent;

const start = (id: string, name: string, args: unknown, parent?: string): SessionEvent => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: name,
  args,
  ...(parent !== undefined ? { parentToolCallId: parent } : {}),
});

const end = (id: string, name: string, result: ToolResult, parent?: string): SessionEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: name,
  result,
  isError: result.isError === true,
  ...(parent !== undefined ? { parentToolCallId: parent } : {}),
});

const ask = (
  requestId: string,
  toolName: string,
  context?: { toolCallId?: string; depth?: number },
): SessionEvent =>
  ({
    type: "permission_request",
    requestId,
    toolName,
    input: {},
    reason: "mode",
    timeoutMs: 1000,
    ...(context !== undefined ? { context } : {}),
  }) as SessionEvent;

/** 某个 toolCallId 的状态序列（tool_call 与 tool_call_update 都算）。 */
function statuses(out: readonly AcpSessionUpdate[], id: string): string[] {
  return out.flatMap((u) =>
    (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
    u.toolCallId === id &&
    u.status !== undefined
      ? [u.status]
      : [],
  );
}

describe("AcpEventMapper", () => {
  it("上游在后续回合复用工具调用 id：线上 id 加 #n 保持会话内唯一，开始 / 结束 / 审批 / 标题都跟着映射", () => {
    const { m, out } = mapper();
    const ok: ToolResult = { content: "ok" };
    m.onEvent(toolcallEnd("call_0", "read", { path: "a.ts" }));
    m.onEvent(start("call_0", "read", { path: "a.ts" }));
    m.onEvent(end("call_0", "read", ok));
    m.onEvent(toolcallEnd("call_0", "bash", { command: "ls" }));
    expect(m.wireId("call_0")).toBe("call_0#2");
    expect(m.titleFor("call_0")).toMatch(/^bash/);
    m.onEvent(start("call_0", "bash", { command: "ls" }));
    m.onEvent(ask("r1", "bash", { toolCallId: "call_0" }));
    m.onEvent(end("call_0", "bash", ok));
    expect(statuses(out, "call_0")).toEqual(["pending", "in_progress", "completed"]);
    expect(statuses(out, "call_0#2")).toEqual(["pending", "in_progress", "pending", "completed"]);
    expectValid(out);
  });

  it("回放：重复的工具调用 id 同样分开（客户端按 id 合并条目）", () => {
    const { m, out } = mapper();
    const call = (id: string, name: string) =>
      ({
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: {} }],
      }) as unknown as AgentMessage;
    const result = (id: string) =>
      ({
        role: "toolResult",
        toolCallId: id,
        content: "done",
        isError: false,
      }) as unknown as AgentMessage;
    m.replay([
      call("fake_call_1", "read"),
      result("fake_call_1"),
      call("fake_call_1", "edit"),
      result("fake_call_1"),
    ]);
    const ids = out.flatMap((u) => (u.sessionUpdate === "tool_call" ? [u.toolCallId] : []));
    expect(ids).toEqual(["fake_call_1", "fake_call_1#2"]);
    expect(statuses(out, "fake_call_1#2")).toEqual(["pending", "completed"]);
    expectValid(out);
  });

  it("tool_call 带 name；审批路径 pending → in_progress → pending → in_progress → completed", () => {
    const { m, out } = mapper();
    m.onEvent(toolcallEnd("c1", "bash", { command: "ls" }));
    m.onEvent(start("c1", "bash", { command: "ls" }));
    m.onEvent(ask("r1", "bash", { toolCallId: "c1" }));
    m.onEvent({ type: "permission_resolved", requestId: "r1", decision: "allow" });
    m.onEvent(end("c1", "bash", { content: "a\nb" }));
    expect(out[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      name: "bash",
      title: "bash: ls",
      kind: "execute",
      status: "pending",
    });
    expect(out[0]).not.toHaveProperty("_meta");
    expect(statuses(out, "c1")).toEqual([
      "pending",
      "in_progress",
      "pending",
      "in_progress",
      "completed",
    ]);
    expect(out.at(-1)).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "a\nb" } }],
    });
    expectValid(out);
  });

  it("拒绝：不发 in_progress，由 tool_execution_end（failed）收口；未公布的 id 与子 Agent 请求不动状态", () => {
    const { m, out } = mapper();
    m.onEvent(toolcallEnd("c1", "write", { path: "a.txt", content: "x" }));
    m.onEvent(start("c1", "write", {}));
    m.onEvent(ask("r1", "write", { toolCallId: "c1" }));
    m.onEvent({ type: "permission_resolved", requestId: "r1", decision: "deny" });
    m.onEvent(end("c1", "write", { content: "The user denied write", isError: true }));
    expect(statuses(out, "c1")).toEqual(["pending", "in_progress", "pending", "failed"]);
    const before = out.length;
    m.onEvent(ask("r2", "bash", { toolCallId: "unknown" }));
    m.onEvent(ask("r3", "bash"));
    m.onEvent(toolcallEnd("c2", "bash", { command: "x" }));
    m.onEvent(ask("r4", "bash", { toolCallId: "c2", depth: 1 }));
    m.onEvent({ type: "permission_resolved", requestId: "r4", decision: "allow" });
    expect(out.slice(before).map((u) => u.sessionUpdate)).toEqual(["tool_call"]);
    expectValid(out);
  });

  it("codemode 内层调用单列：title 前缀、_meta.ama.parentToolCallId、各自收口", () => {
    const { m, out } = mapper();
    m.onEvent(toolcallEnd("cm", "codemode", { script: "…" }));
    m.onEvent(start("cm", "codemode", { script: "…" }));
    m.onEvent(start("cm_n1", "bash", { command: "echo hi" }, "cm"));
    m.onEvent(ask("r1", "bash", { toolCallId: "cm_n1" }));
    m.onEvent({ type: "permission_resolved", requestId: "r1", decision: "allow_session" });
    m.onEvent(end("cm_n1", "bash", { content: "hi" }, "cm"));
    m.onEvent(end("cm", "codemode", { content: "done" }));
    const inner = out.find((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "cm_n1");
    expect(inner).toMatchObject({
      name: "bash",
      title: "codemode › bash: echo hi",
      kind: "execute",
      status: "pending",
      _meta: { ama: { parentToolCallId: "cm" } },
    });
    expect(statuses(out, "cm_n1")).toEqual([
      "pending",
      "in_progress",
      "pending",
      "in_progress",
      "completed",
    ]);
    expect(statuses(out, "cm")).toEqual(["pending", "in_progress", "completed"]);
    expectValid(out);
  });

  it("titleFor：已公布未结束的调用可查标题（内层带前缀），结束后清掉", () => {
    const { m } = mapper();
    m.onEvent(start("cm_n1", "read", { path: "a.md" }, "cm"));
    expect(m.titleFor("cm_n1")).toBe("codemode › read: a.md");
    m.onEvent(end("cm_n1", "read", { content: "x" }, "cm"));
    expect(m.titleFor("cm_n1")).toBeUndefined();
  });

  it("edit：content 为 [diff, text]，locations 带首个改动行；新文件 oldText null", () => {
    const { m, out } = mapper();
    m.onEvent(
      end("e1", "edit", {
        content: "Edited a.txt: 1 replacement",
        fileChange: {
          path: "/work/a.txt",
          oldText: "a\nb\n",
          newText: "a\nc\n",
          firstChangedLine: 2,
        },
      }),
    );
    m.onEvent(
      end("w1", "write", {
        content: "Created n.txt (2 bytes)",
        fileChange: { path: "/work/n.txt", oldText: null, newText: "x\n", firstChangedLine: 1 },
      }),
    );
    expect(out[0]).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "e1",
      status: "completed",
      content: [
        { type: "diff", path: "/work/a.txt", oldText: "a\nb\n", newText: "a\nc\n" },
        { type: "content", content: { type: "text", text: "Edited a.txt: 1 replacement" } },
      ],
      locations: [{ path: "/work/a.txt", line: 2 }],
    });
    expect(out[1]).toMatchObject({
      content: [{ type: "diff", path: "/work/n.txt", oldText: null, newText: "x\n" }, {}],
    });
    expect(out[0]).not.toHaveProperty("rawOutput");
    expectValid(out);
  });

  it("结果文本只回前 4 KB，附截断说明；超限无 fileChange 时没有 diff", () => {
    const { m, out } = mapper();
    m.onEvent(end("b1", "bash", { content: "y".repeat(TOOL_OUTPUT_LIMIT + 10) }));
    const update = out[0];
    if (update?.sessionUpdate !== "tool_call_update") throw new Error("expected update");
    expect(update.content).toHaveLength(1);
    const block = update.content?.[0];
    const text =
      block?.type === "content" && block.content.type === "text" ? block.content.text : "";
    expect(text.startsWith("y".repeat(TOOL_OUTPUT_LIMIT))).toBe(true);
    expect(text.length).toBeGreaterThan(TOOL_OUTPUT_LIMIT);
    expect(text).not.toContain("y".repeat(TOOL_OUTPUT_LIMIT + 1));
    expect(update).not.toHaveProperty("locations");
  });

  it("model_changed / thinking_level_changed → config_option_update（取 extras）", () => {
    const { m, out } = mapper();
    m.onEvent({ type: "model_changed", model: { provider: "fake", id: "echo" } } as SessionEvent);
    m.onEvent({ type: "thinking_level_changed", level: "high" });
    expect(out).toEqual([
      { sessionUpdate: "config_option_update", configOptions: CONFIG },
      { sessionUpdate: "config_option_update", configOptions: CONFIG },
    ]);
    expectValid(out);
  });

  it("announce 发命令表与配置项；emitSessionInfo 只在标题变化时带 title", () => {
    const { m, out } = mapper();
    m.announce();
    m.emitSessionInfo(null, "2026-10-04T00:00:00.000Z");
    m.emitSessionInfo("fix bug", "2026-10-04T00:00:01.000Z");
    m.emitSessionInfo("fix bug", "2026-10-04T00:00:02.000Z");
    m.emitSessionInfo("renamed", "2026-10-04T00:00:03.000Z");
    expect(out).toEqual([
      { sessionUpdate: "available_commands_update", availableCommands: COMMANDS },
      { sessionUpdate: "config_option_update", configOptions: CONFIG },
      { sessionUpdate: "session_info_update", updatedAt: "2026-10-04T00:00:00.000Z" },
      {
        sessionUpdate: "session_info_update",
        title: "fix bug",
        updatedAt: "2026-10-04T00:00:01.000Z",
      },
      { sessionUpdate: "session_info_update", updatedAt: "2026-10-04T00:00:02.000Z" },
      {
        sessionUpdate: "session_info_update",
        title: "renamed",
        updatedAt: "2026-10-04T00:00:03.000Z",
      },
    ]);
    expectValid(out);
  });

  it("usage_update：announce 与换模型照发；助手 message_end / turn_end 同值去重；窗口未知不发", () => {
    let stats: Record<string, unknown> = { contextTokens: 0, contextWindow: 1000, cost: 0 };
    const { m, out } = mapper(() => stats);
    const usage = () => out.filter((u) => u.sessionUpdate === "usage_update");
    const assistant = { type: "message_end", message: { role: "assistant" } } as SessionEvent;
    m.announce();
    m.announce(); // 再次 load：客户端可能刚重建线程，照发
    expect(usage()).toEqual([
      { sessionUpdate: "usage_update", used: 0, size: 1000, cost: { amount: 0, currency: "USD" } },
      { sessionUpdate: "usage_update", used: 0, size: 1000, cost: { amount: 0, currency: "USD" } },
    ]);
    out.length = 0;
    stats = { contextTokens: 120, contextWindow: 1000, cost: 0.5 };
    m.onEvent({ type: "message_end", message: { role: "user" } } as SessionEvent);
    expect(usage()).toEqual([]);
    m.onEvent(assistant);
    m.onEvent({ type: "turn_end" } as SessionEvent);
    expect(usage()).toEqual([
      {
        sessionUpdate: "usage_update",
        used: 120,
        size: 1000,
        cost: { amount: 0.5, currency: "USD" },
      },
    ]);
    stats = { contextTokens: 300, contextWindow: 1000, cost: 0.5 };
    m.onEvent(assistant); // 多工具轮内的下一条助手消息
    m.onEvent({ type: "model_changed", model: { provider: "fake", id: "echo" } } as SessionEvent);
    expect(usage().map((u) => (u as { used: number }).used)).toEqual([120, 300, 300]);
    expectValid(out);
    out.length = 0;
    stats = { contextTokens: 300 };
    m.announce();
    m.onEvent(assistant);
    expect(usage()).toEqual([]);
  });

  it("回放：tool_call 带 name，toolResult 带前 4 KB 文本、无 diff", () => {
    const { m, out } = mapper();
    const messages = [
      { role: "user", content: "go", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.md" } }],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "z".repeat(TOOL_OUTPUT_LIMIT + 1) }],
        isError: false,
        timestamp: 0,
      },
    ] as unknown as AgentMessage[];
    m.replay(messages);
    expect(out[1]).toMatchObject({ sessionUpdate: "tool_call", name: "read", title: "read: a.md" });
    const result = out[2];
    if (result?.sessionUpdate !== "tool_call_update") throw new Error("expected update");
    expect(result.status).toBe("completed");
    expect(result.content).toHaveLength(1);
    expect(result.content?.[0]).toMatchObject({ type: "content", content: { type: "text" } });
    expect(JSON.stringify(result)).toContain(msg().acp.tools.truncated(TOOL_OUTPUT_LIMIT + 1));
    expectValid(out);
  });

  it("permissionModes：name 为显示名、description 走 i18n，通过 schema", () => {
    const modes = permissionModes("default");
    expect(modes.availableModes.find((m) => m.id === "full-auto")).toMatchObject({
      name: "Bypass permissions",
    });
    for (const mode of modes.availableModes) expect(mode.description).not.toBe("");
    expect(validateAcp("SessionModeState", modes)).toEqual([]);
  });
});

describe("AcpEventMapper 接真实会话（codemode）", () => {
  it("内层调用的权限请求 context.toolCallId 都是已公布的 tool_call，且最终 completed", async () => {
    const script: FakeResponse[] = [
      {
        steps: [
          {
            toolCall: {
              name: "codemode",
              arguments: {
                script:
                  "await tools.write({path:'b.txt',content:'x'}); return await tools.bash({command:'echo cm'});",
              },
            },
          },
        ],
      },
      { text: "ok" },
    ];
    h = composeHarness(script);
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      permission: { allow: ["codemode"] },
    });
    const runtime = await h.boot([
      "--mode",
      "rpc",
      "--model",
      "fake/echo",
      "--tools-preset",
      "codemode",
    ]);
    const asked: (string | undefined)[] = [];
    runtime.approvals.setUiBroker({
      ask: async (request) => {
        asked.push(request.context?.toolCallId);
        return "allow";
      },
    });
    const out: AcpSessionUpdate[] = [];
    const m = new AcpEventMapper(
      runtime.paths.cwd,
      (u) => out.push(u),
      () => runtime.session,
    );
    const events: SessionEvent[] = [];
    const off = runtime.session.subscribe((event) => {
      events.push(event);
      m.onEvent(event);
    });
    await runtime.session.prompt("go");
    off();
    await runtime.dispose();

    const published = new Set(
      out.flatMap((u) => (u.sessionUpdate === "tool_call" ? [u.toolCallId] : [])),
    );
    const requested = events.flatMap((e) =>
      e.type === "permission_request" ? [e.context?.toolCallId] : [],
    );
    expect(requested).toHaveLength(2);
    expect(asked).toEqual(requested);
    for (const id of requested) {
      expect(id).toBeDefined();
      expect(published.has(id!)).toBe(true);
      expect(statuses(out, id!)).toEqual([
        "pending",
        "in_progress",
        "pending",
        "in_progress",
        "completed",
      ]);
    }
    // 每条公布的调用最终都收口
    for (const id of published) expect(statuses(out, id).at(-1)).toBe("completed");
    const write = out.find(
      (u) => u.sessionUpdate === "tool_call_update" && u.content?.[0]?.type === "diff",
    );
    expect(write).toMatchObject({ content: [{ type: "diff", oldText: null, newText: "x" }, {}] });
    expectValid(out);
  });
});
