/**
 * 第五波契约的编译期断言（docs/wave5-plan.md §9、§10；[W5-C0]）。
 * 全部是可选字段或新增类型：旧代码不必改动就能编译；改契约时先改这里。
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AnthropicMessagesCompat,
  Model,
  OpenAIResponsesCompat,
  ProviderCompat,
  ProviderData,
} from "./ai/types.js";
import type { BuiltinProvider } from "./ai/providers/builtin.js";
import type { ContextEditEntry, ContextEditReason } from "./session/types.js";
import type {
  PlanData,
  SessionEvent,
  SessionStats,
  SessionTelemetry,
  SubagentStatus,
} from "./agent/types.js";
import type { AgentSessionOptions } from "./agent/session-core.js";
import type { RpcCapability, RpcCommand, RpcCommandType, RpcEvent, RpcW5Results } from "./rpc.js";
import { RPC_PROTOCOL_VERSION } from "./rpc.js";
import type {
  RunnerHandle,
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
  ToolAnnotations,
  ToolContext,
} from "./tools/types.js";
import type { ApprovalRequestContext } from "./permissions/types.js";
import type { AgentEvents, HostApi, HostRunner } from "./host/types.js";
import type { HookEvent, HookInput } from "./hooks/types.js";
import { HOOK_EVENTS } from "./hooks/types.js";
import { blockingDecision } from "./hooks/protocol.js";
import type {
  AgentDriver,
  DriverPermissionOutcome,
  DriverPermissionRequest,
  DriverSession,
} from "./drivers/types.js";
import type { AgentDefinition, AgentRunnerSpec } from "./agents/types.js";

describe("第五波 ①：模型元数据、内置渠道、Anthropic compat、image_budget", () => {
  it("Model 的 models.dev 元数据字段全部可选", () => {
    expectTypeOf<Model["family"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Model["knowledge"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Model["releaseDate"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Model["inputLimit"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Model["status"]>().toEqualTypeOf<"beta" | undefined>();
    const model: Model = {
      id: "m",
      name: "m",
      provider: "p",
      api: "anthropic-messages",
      input: ["text"],
      reasoning: false,
      maxTokens: 1,
      family: "claude-sonnet",
      knowledge: "2026-01",
      releaseDate: "2026-03-01",
      inputLimit: 200_000,
      status: "beta",
    };
    expect(model.status).toBe("beta");
  });

  it("内置供应商可以带内置渠道与缺省渠道", () => {
    expectTypeOf<BuiltinProvider["channels"]>().toEqualTypeOf<ProviderData["channels"]>();
    expectTypeOf<BuiltinProvider["defaultChannel"]>().toEqualTypeOf<string | undefined>();
    const provider: BuiltinProvider = {
      id: "deepseek",
      name: "DeepSeek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      envKeys: ["DEEPSEEK_API_KEY"],
      requiresApiKey: true,
      channels: [
        {
          name: "messages",
          api: "anthropic-messages",
          baseUrl: "https://api.deepseek.com/anthropic",
        },
      ],
      defaultChannel: "chat",
    };
    expect(provider.channels?.[0]?.name).toBe("messages");
  });

  it("Anthropic / Responses 的新 compat 开关可选，并入 ProviderCompat", () => {
    expectTypeOf<AnthropicMessagesCompat["sendInterleavedThinkingBeta"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<AnthropicMessagesCompat["sendCacheControl"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<OpenAIResponsesCompat["explicitCacheField"]>().toEqualTypeOf<
      "volcengine" | undefined
    >();
    const compat: ProviderCompat = {
      sendCacheControl: false,
      sendInterleavedThinkingBeta: false,
      explicitCacheField: "volcengine",
    };
    expect(compat.sendCacheControl).toBe(false);
  });

  it("ContextEditReason 含 image_budget", () => {
    expectTypeOf<"image_budget">().toExtend<ContextEditReason>();
    const edit: Pick<ContextEditEntry, "type" | "reason" | "replacement"> = {
      type: "context_edit",
      reason: "image_budget",
      replacement: "[earlier image omitted to fit request size]",
    };
    expect(edit.reason).toBe("image_budget");
  });
});

describe("第五波 ②：SessionEvent 新事件与 SessionStats 扩展", () => {
  it("新事件并入 SessionEvent，RpcEvent 自动包含", () => {
    type W5Type =
      | "telemetry_tick"
      | "subagent_start"
      | "subagent_update"
      | "subagent_end"
      | "plan_proposed"
      | "plan_resolved"
      | "todo_updated"
      | "limit_reached"
      | "model_fallback"
      | "background_job";
    expectTypeOf<W5Type>().toExtend<SessionEvent["type"]>();
    expectTypeOf<W5Type>().toExtend<RpcEvent["type"]>();
    type End = Extract<SessionEvent, { type: "subagent_end" }>;
    expectTypeOf<End["status"]>().toEqualTypeOf<SubagentStatus>();
    expectTypeOf<SubagentStatus>().toEqualTypeOf<
      "completed" | "failed" | "aborted" | "max_turns" | "interrupted"
    >();
    type Resolved = Extract<SessionEvent, { type: "plan_resolved" }>;
    expectTypeOf<Resolved["decision"]>().toEqualTypeOf<
      "approve" | "approve_fresh" | "revise" | "reject"
    >();
    type Limit = Extract<SessionEvent, { type: "limit_reached" }>;
    expectTypeOf<Limit["kind"]>().toEqualTypeOf<"turns" | "cost">();
    const events: SessionEvent[] = [
      { type: "telemetry_tick" },
      {
        type: "subagent_start",
        taskId: "t1",
        parentToolCallId: "c1",
        agent: "explore",
        runner: "ama",
        description: "find usages",
        background: true,
        cwd: "/w",
      },
      { type: "subagent_update", taskId: "t1", kind: "tool", toolName: "grep", turn: 2 },
      { type: "subagent_end", taskId: "t1", status: "completed" },
      { type: "plan_proposed", planId: "p1", version: 1, markdown: "# x", steps: [] },
      { type: "plan_resolved", planId: "p1", decision: "approve", mode: "auto-edit" },
      { type: "todo_updated", items: [{ id: "1", text: "a", status: "pending", planStep: "S1" }] },
      { type: "limit_reached", kind: "cost", value: 1.02, limit: 1 },
      {
        type: "model_fallback",
        from: { provider: "a", id: "x" },
        to: { provider: "b", id: "y" },
        reason: "overloaded",
      },
      { type: "background_job", jobId: "j1", phase: "exited", command: "sleep 1", exitCode: 0 },
    ];
    expect(events).toHaveLength(10);
  });

  it("SessionStats.telemetry / external / tasks 可选；PlanData 形状", () => {
    expectTypeOf<SessionStats["telemetry"]>().toEqualTypeOf<SessionTelemetry | undefined>();
    expectTypeOf<NonNullable<SessionStats["external"]>["byAgent"][string]["unit"]>().toEqualTypeOf<
      "usd" | "tokens" | "requests"
    >();
    expectTypeOf<NonNullable<SessionStats["tasks"]>["running"]>().toEqualTypeOf<number>();
    expectTypeOf<PlanData["status"]>().toEqualTypeOf<
      "proposed" | "approved" | "rejected" | "superseded"
    >();
  });

  it("AgentSessionOptions.limits / fallbackModel 可选", () => {
    expectTypeOf<AgentSessionOptions["limits"]>().toEqualTypeOf<
      { maxTurns?: number; maxCostUsd?: number } | undefined
    >();
    expectTypeOf<AgentSessionOptions["fallbackModel"]>().toEqualTypeOf<string | undefined>();
  });
});

describe("第五波 ④：runner / 驱动 / 定义文件、审批来源、宿主 runner、PostCompact", () => {
  it("工具契约：annotations、SubagentRequest / Result 新字段全部可选，ToolContext.tasks 可选", () => {
    expectTypeOf<ToolAnnotations["pollable"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ToolAnnotations["keepInContext"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<SubagentRequest["isolation"]>().toEqualTypeOf<"none" | "worktree" | undefined>();
    expectTypeOf<SubagentRequest["background"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<SubagentResult["taskId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SubagentResult["status"]>().toEqualTypeOf<
      SubagentStatus | "running" | undefined
    >();
    expectTypeOf<ToolContext["tasks"]>().not.toBeAny();
    // 旧形状仍可赋值（向后兼容）
    const legacy: SubagentResult = {
      text: "x",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "stop",
      isError: false,
    };
    expect(legacy.status).toBeUndefined();
  });

  it("SubagentRunner 可实现：start → RunnerHandle（send / wait / stop）", async () => {
    const runner: SubagentRunner = {
      id: "claude",
      async start(request) {
        request.onEvent({ type: "text", delta: "hi" });
        const handle: RunnerHandle = {
          id: "ext-1",
          send: async () => {},
          wait: async () => ({
            text: "done",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            stopReason: "stop",
            isError: false,
            status: "completed",
            sessionRef: { runner: "claude", sessionId: "ext-1" },
          }),
          stop: async () => {},
        };
        return handle;
      },
    };
    const deltas: string[] = [];
    const handle = await runner.start({
      prompt: "p",
      cwd: "/w",
      mode: "plan",
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.type === "text") deltas.push(event.delta);
      },
    });
    expect((await handle.wait()).status).toBe("completed");
    expect(deltas).toEqual(["hi"]);
  });

  it("驱动契约：权限请求只有选项或取消两种结果", () => {
    expectTypeOf<DriverPermissionOutcome>().toEqualTypeOf<
      { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
    >();
    expectTypeOf<DriverPermissionRequest["options"][number]["kind"]>().toEqualTypeOf<
      "allow_once" | "allow_always" | "reject_once" | "reject_always"
    >();
    expectTypeOf<ReturnType<AgentDriver["open"]>>().toEqualTypeOf<Promise<DriverSession>>();
    expectTypeOf<AgentDriver["kind"]>().toEqualTypeOf<
      "acp" | "acp-adapter" | "claude-stream" | "codex-app-server" | "oneshot" | "host"
    >();
  });

  it("AgentDefinition 与 runner 规格", () => {
    expectTypeOf<"acp:gemini">().toExtend<AgentRunnerSpec>();
    expectTypeOf<AgentDefinition["permissionMode"]>().toEqualTypeOf<"plan" | "inherit">();
    const reviewer: AgentDefinition = {
      name: "reviewer",
      description: "只读审查",
      tools: ["read", "grep"],
      permissionMode: "plan",
      model: "inherit",
      maxTurns: 20,
      isolation: "none",
      background: false,
      runner: "ama",
      prompt: "你是审查者。",
      source: "project",
      filePath: "/w/.ama/agents/reviewer.md",
    };
    expect(reviewer.runner).toBe("ama");
  });

  it("ApprovalRequestContext.taskId / origin 可选", () => {
    expectTypeOf<ApprovalRequestContext["depth"]>().toEqualTypeOf<number>();
    expectTypeOf<ApprovalRequestContext["parentToolCallId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ApprovalRequestContext["readFiles"]>().toEqualTypeOf<
      ReadonlySet<string> | undefined
    >();
    expectTypeOf<ApprovalRequestContext["taskId"]>().toEqualTypeOf<string | undefined>();
    const context: ApprovalRequestContext = {
      depth: 1,
      taskId: "t1",
      origin: {
        agent: "claude",
        sessionId: "abc1",
        toolCall: { title: "Write a.ts", kind: "edit", locations: ["a.ts"] },
        options: [
          { optionId: "1", kind: "allow_once" },
          { optionId: "2", kind: "reject_once" },
        ],
      },
    };
    expect(context.origin?.options).toHaveLength(2);
  });

  it("HostApi.runners 为可选面；AgentEvents 加子 Agent 与计划事件", () => {
    expectTypeOf<HostApi["runners"]>().toEqualTypeOf<
      { provide(runner: HostRunner): () => void } | undefined
    >();
    expectTypeOf<HostRunner["description"]>().toEqualTypeOf<string>();
    expectTypeOf<"subagent_start" | "subagent_end" | "plan_proposed" | "plan_resolved">().toExtend<
      keyof AgentEvents
    >();
    expectTypeOf<AgentEvents["plan_resolved"]["decision"]>().toEqualTypeOf<
      "approve" | "approve_fresh" | "revise" | "reject"
    >();
  });

  it("Hook 事件 PostCompact（不可阻止）与 tokensAfter", () => {
    expectTypeOf<"PostCompact">().toExtend<HookEvent>();
    expectTypeOf<HookInput["tokensAfter"]>().toEqualTypeOf<number | undefined>();
    expect(HOOK_EVENTS).toContain("PostCompact");
    expect(blockingDecision("PostCompact")).toBeUndefined();
  });
});

describe("第五波 ⑥：RPC 计划 / 任务命令与 plans 能力", () => {
  it("命令登记、参数形状、能力位；协议版本不变", () => {
    expectTypeOf<
      "plan_response" | "get_plan" | "get_todos" | "get_tasks" | "get_agents"
    >().toExtend<RpcCommandType>();
    expectTypeOf<"plans">().toExtend<RpcCapability>();
    const command: RpcCommand = {
      id: "1",
      type: "plan_response",
      planId: "p1",
      decision: "approve",
      mode: "auto-edit",
    };
    expectTypeOf<RpcW5Results["get_plan"]>().toEqualTypeOf<PlanData | null>();
    expect(command.type).toBe("plan_response");
    expect(RPC_PROTOCOL_VERSION).toBe(1);
  });
});
