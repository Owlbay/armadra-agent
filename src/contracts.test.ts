/**
 * 契约类型的编译期断言（B0 验收）：只用 `import type`，确认主要接口可被实现与消费。
 * 这些断言在 `pnpm typecheck` 与 vitest 的类型擦除下都要成立；改契约时先改这里。
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ApiImplementation,
  AssistantEvent,
  AssistantEventStream,
  AssistantMessage,
  AuthHeader,
  Model,
  ProviderData,
  StreamOptions,
  ToolCallBlock,
  TranscriptContext,
} from "./ai/types.js";
import type {
  AgentSession,
  EnqueueOptions,
  LoopHooks,
  PromptOptions,
  SessionEvent,
} from "./agent/types.js";
import type { MessageOrigin } from "./ai/types.js";
import type { HookInput, HookOutput, HookOutcome } from "./hooks/types.js";
import type {
  AgentEvents,
  ApprovalBroker,
  HostAdapter,
  HostApi,
  HostModule,
} from "./host/types.js";
import type { SessionEntry, SessionEntryInput, SessionHeader } from "./session/types.js";
import type { Component, Focusable, Theme } from "./tui/component.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./tools/types.js";
import type { Runtime } from "./cli/runtime.js";
import type { RpcCommand, RpcEvent } from "./rpc.js";
import { HOST_API_VERSION } from "./host/types.js";
import { ExitCode } from "./cli/exit-codes.js";
import { CURSOR_MARKER, isFocusable } from "./tui/component.js";
import { defineTool } from "./tools/types.js";

describe("ai 契约", () => {
  it("ApiImplementation.stream 的签名", () => {
    expectTypeOf<ApiImplementation["stream"]>().parameters.toEqualTypeOf<
      [Model, TranscriptContext, StreamOptions]
    >();
    expectTypeOf<ApiImplementation["stream"]>().returns.toEqualTypeOf<AssistantEventStream>();
    expectTypeOf<AssistantEventStream>().toMatchTypeOf<AsyncIterable<AssistantEvent>>();
    expectTypeOf<ReturnType<AssistantEventStream["result"]>>().toEqualTypeOf<
      Promise<AssistantMessage>
    >();
  });

  it("AssistantEvent 的判别与终止事件", () => {
    expectTypeOf<AssistantEvent["type"]>().toEqualTypeOf<
      | "start"
      | "text_start"
      | "text_end"
      | "text_delta"
      | "thinking_start"
      | "thinking_end"
      | "thinking_delta"
      | "toolcall_start"
      | "toolcall_delta"
      | "toolcall_end"
      | "done"
      | "error"
    >();
    expectTypeOf<
      Extract<AssistantEvent, { type: "toolcall_end" }>["toolCall"]
    >().toEqualTypeOf<ToolCallBlock>();
    expectTypeOf<Extract<AssistantEvent, { type: "done" }>["reason"]>().toEqualTypeOf<
      "stop" | "length" | "toolUse"
    >();
    expectTypeOf<Extract<AssistantEvent, { type: "error" }>["reason"]>().toEqualTypeOf<
      "aborted" | "error"
    >();
  });

  it("可以写出一个最小协议实现", () => {
    const impl: ApiImplementation<{ maxTokensField: string }> = {
      id: "openai-completions",
      stream: () => ({
        async *[Symbol.asyncIterator]() {},
        result: () => Promise.reject(new Error("unused")),
      }),
      detectCompat: (_model: Model, provider: ProviderData) => ({
        maxTokensField: provider.id === "openai" ? "max_completion_tokens" : "max_tokens",
      }),
    };
    expect(impl.id).toBe("openai-completions");
  });
});

describe("ai 契约（B1 追加）", () => {
  it("Model.authHeader / Model.requiresApiKey：registry 从 ProviderData 物化", () => {
    expectTypeOf<Model["authHeader"]>().toEqualTypeOf<AuthHeader | undefined>();
    expectTypeOf<Model["requiresApiKey"]>().toEqualTypeOf<boolean | undefined>();
  });
});

describe("工具契约", () => {
  it("ToolDefinition 可用 defineTool 推断输入类型，并能赋给 ToolDefinition", () => {
    const tool = defineTool<{ path: string }>({
      name: "read_x",
      description: "d",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      permission: "read",
      async execute(input, ctx) {
        expectTypeOf(input).toEqualTypeOf<{ path: string }>();
        expectTypeOf(ctx).toEqualTypeOf<ToolContext>();
        return { content: input.path };
      },
    });
    const erased: ToolDefinition = tool;
    expect(erased.name).toBe("read_x");
    expectTypeOf<ReturnType<ToolDefinition["execute"]>>().toEqualTypeOf<Promise<ToolResult>>();
    expectTypeOf<ToolDefinition["permission"]>().toEqualTypeOf<"read" | "write" | "execute">();
    expectTypeOf<ToolContext["readFiles"]>().toEqualTypeOf<ReadonlySet<string>>();
  });
});

describe("Hook 契约", () => {
  it("HookInput / HookOutput 形状", () => {
    expectTypeOf<HookInput["hookEventName"]>().toEqualTypeOf<
      | "SessionStart"
      | "UserPromptSubmit"
      | "PreToolUse"
      | "PostToolUse"
      | "Stop"
      | "SubagentStop"
      | "PreCompact"
      | "Notification"
      | "SessionEnd"
    >();
    expectTypeOf<HookOutput["decision"]>().toEqualTypeOf<
      "allow" | "deny" | "ask" | "block" | undefined
    >();
    expectTypeOf<HookOutput["continue"]>().toEqualTypeOf<false | undefined>();
    expectTypeOf<HookOutcome["decision"]>().toEqualTypeOf<HookOutput["decision"]>();
    const output: HookOutput = { decision: "deny", reason: "no" };
    expect(output.decision).toBe("deny");
  });
});

describe("宿主契约", () => {
  it("HostModule / HostApi", () => {
    expect(HOST_API_VERSION).toBe(1);
    const module: HostModule = {
      hostApi: HOST_API_VERSION,
      create(api: HostApi): HostAdapter | undefined {
        expectTypeOf(api.mode).toEqualTypeOf<"interactive" | "line" | "print" | "rpc">();
        const off = api.events.on("tool_call", (event) => {
          expectTypeOf(event).toEqualTypeOf<AgentEvents["tool_call"]>();
        });
        expectTypeOf(off).toEqualTypeOf<() => void>();
        const broker: ApprovalBroker = { ask: async () => undefined };
        api.approvals.setBroker(broker);
        return api.env["ARMADRA_NODE_ID"] === undefined ? undefined : { id: "test" };
      },
    };
    expect(module.hostApi).toBe(1);
    expectTypeOf<ReturnType<HostApi["messages"]["sendUser"]>>().toEqualTypeOf<
      Promise<"started" | "queued">
    >();
    expectTypeOf<Parameters<HostApi["tools"]["register"]>[0]>().toEqualTypeOf<ToolDefinition>();
  });
});

describe("TUI 契约", () => {
  it("Component / Focusable / Theme", () => {
    class Line implements Component, Focusable {
      focused = false;
      render(width: number): string[] {
        return [`${"x".repeat(width)}${this.focused ? CURSOR_MARKER : ""}`];
      }
      invalidate(): void {}
    }
    const line = new Line();
    expect(isFocusable(line)).toBe(true);
    expect(isFocusable({ render: () => [], invalidate() {} })).toBe(false);
    expect(line.render(2)).toEqual(["xx"]);
    expectTypeOf<Theme["fg"]>().parameters.toEqualTypeOf<
      [
        (
          | "text"
          | "dim"
          | "accent"
          | "success"
          | "warning"
          | "error"
          | "user"
          | "assistant"
          | "tool"
          | "border"
          | "code"
        ),
        string,
      ]
    >();
    expectTypeOf<Theme["caps"]["colors"]>().toEqualTypeOf<0 | 16 | 256 | 16_777_216>();
  });
});

describe("会话契约", () => {
  it("SessionEntry 判别联合与 append 入参", () => {
    expectTypeOf<SessionEntry["type"]>().toEqualTypeOf<
      | "message"
      | "compaction"
      | "branch_summary"
      | "context_edit"
      | "model_change"
      | "thinking_level_change"
      | "custom"
      | "custom_message"
      | "label"
      | "session_info"
    >();
    const input: SessionEntryInput = {
      type: "context_edit",
      targetId: "e1",
      replacement: null,
      reason: "abort",
    };
    expectTypeOf(input).not.toHaveProperty("id");
    expectTypeOf<SessionHeader["version"]>().toEqualTypeOf<1>();
    expectTypeOf<Extract<SessionEntry, { type: "message" }>["message"]["role"]>().toEqualTypeOf<
      "system" | "user" | "assistant" | "toolResult"
    >();
  });
});

describe("循环、SDK、RPC、Runtime 契约", () => {
  it("LoopHooks / AgentSession / SessionEvent", () => {
    expectTypeOf<LoopHooks["beforeToolCall"]>().returns.toEqualTypeOf<
      Promise<{ block?: boolean; reason?: string; input?: unknown }>
    >();
    expectTypeOf<ReturnType<AgentSession["prompt"]>>().toEqualTypeOf<
      Promise<"started" | "queued" | "handled">
    >();
    expectTypeOf<PromptOptions["origin"]>().toEqualTypeOf<MessageOrigin | undefined>();
    expectTypeOf<EnqueueOptions["origin"]>().toEqualTypeOf<MessageOrigin | undefined>();
    expectTypeOf<Parameters<AgentSession["steer"]>>().toEqualTypeOf<
      [text: string, options?: EnqueueOptions]
    >();
    expectTypeOf<Parameters<AgentSession["followUp"]>>().toEqualTypeOf<
      [text: string, options?: EnqueueOptions]
    >();
    expectTypeOf<Extract<SessionEvent, { type: "agent_end" }>>().toEqualTypeOf<{
      type: "agent_end";
      stopReason: string;
      willRetry: boolean;
    }>();
  });

  it("RPC 线上 message_update 是纯增量", () => {
    type Update = Extract<RpcEvent, { type: "message_update" }>;
    expectTypeOf<Update>().not.toHaveProperty("message");
    expectTypeOf<Update["assistantMessageEvent"]>().not.toHaveProperty("partial");
    const cmd: RpcCommand = { id: "1", type: "prompt", message: "hi" };
    const abort: RpcCommand = { type: "abort" };
    expect([cmd.type, abort.type]).toEqual(["prompt", "abort"]);
  });

  it("Runtime 汇集各批次接口", () => {
    expectTypeOf<Runtime["session"]>().toEqualTypeOf<AgentSession>();
    expectTypeOf<Runtime["host"]>().toMatchTypeOf<object | undefined>();
    expect(ExitCode.HostVersion).toBe(78);
  });
});
