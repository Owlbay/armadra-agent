/**
 * 第六波契约的编译期断言（docs/wave6-plan.md §7、§8；[W6-C0]）。
 * 全部是可选字段、新命令或新键：旧代码不必改动就能编译；改契约时先改这里。
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { KeySource, OpenAIResponsesCompat, Usage } from "./ai/types.js";
import type { SessionEvent, SessionStats } from "./agent/types.js";
import type { QuotaUpdateEvent } from "./agent/types-w6.js";
import { SECTION_ORDER, type SystemPromptInput } from "./agent/system-prompt.js";
import type { TaskHandle, ExternalDisplayEvent, ProgressSink } from "./agents/task-record.js";
import type {
  AmaConfig,
  AuthFile,
  OAuthAuthEntry,
  ProfileFile,
  ProfileMemoryOptions,
  UiConfig,
} from "./config/types.js";
import type { CliConfigOverrides } from "./config/merge.js";
import type { ApprovalRequestContext, PermissionRequestContext } from "./permissions/types.js";
import type { SubagentEvent, ToolPermission } from "./tools/types.js";
import type { RpcCommandType, RpcGetTraceParams, RpcModelInfo, RpcW6Results } from "./rpc.js";
import { RPC_PROTOCOL_VERSION } from "./rpc.js";
import { HOST_API_VERSION } from "./host/types.js";
import { SESSION_FORMAT_VERSION } from "./session/types.js";
import type { CreateSessionOptions, RuntimeOptions, SdkAgentSession } from "./sdk.js";
import type { ParsedArgs } from "./cli/args.js";
import type { CommandContext } from "./modes/commands-core.js";
import type { CommandUi } from "./modes/interactive/commands.js";
import type { Locale, Trace, TraceEntryData } from "./index.js";
import { TRACE_CUSTOM_TYPE } from "./index.js";

describe("第六波 ①：i18n 与语言", () => {
  it("Locale、ui.language、profile / SDK / 命令行的 language", () => {
    expectTypeOf<Locale>().toEqualTypeOf<"zh" | "en">();
    expectTypeOf<UiConfig["language"]>().toEqualTypeOf<"auto" | "zh" | "en" | undefined>();
    expectTypeOf<ProfileFile["language"]>().toEqualTypeOf<"zh" | "en" | undefined>();
    expectTypeOf<RuntimeOptions["language"]>().toEqualTypeOf<Locale | undefined>();
    expectTypeOf<CreateSessionOptions["language"]>().toEqualTypeOf<Locale | undefined>();
    expectTypeOf<ParsedArgs["lang"]>().toEqualTypeOf<Locale | undefined>();
  });
});

describe("第六波 ②：轨迹", () => {
  it("ama.trace 条目与轨迹树经 @armadra/agent 导出", () => {
    expect(TRACE_CUSTOM_TYPE).toBe("ama.trace");
    expectTypeOf<TraceEntryData["kind"]>().toEqualTypeOf<
      "step" | "retry_wait" | "fallback" | "compaction" | "aux" | "external_turn"
    >();
    expectTypeOf<Trace["version"]>().toEqualTypeOf<1>();
  });

  it("审批带 toolCallId；SubagentEvent.tool 带 id / at；turn_trace；TaskHandle 视图钩子", () => {
    expectTypeOf<ApprovalRequestContext["toolCallId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PermissionRequestContext["toolCallId"]>().toEqualTypeOf<string | undefined>();
    type ToolEvent = Extract<SubagentEvent, { type: "tool" }>;
    expectTypeOf<ToolEvent["id"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ToolEvent["at"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<"turn_trace">().toExtend<SubagentEvent["type"]>();
    expectTypeOf<TaskHandle["observe"]>().toEqualTypeOf<
      ((listener: (event: SessionEvent) => void) => () => void) | undefined
    >();
    expectTypeOf<ReturnType<NonNullable<TaskHandle["recent"]>>>().toEqualTypeOf<
      readonly ExternalDisplayEvent[]
    >();
    expectTypeOf<ProgressSink["appendTrace"]>().not.toBeUndefined();
  });

  it("RPC get_trace 与 SDK session.trace()", () => {
    expectTypeOf<"get_trace">().toExtend<RpcCommandType>();
    expectTypeOf<RpcGetTraceParams["branch"]>().toEqualTypeOf<"leaf" | "all" | undefined>();
    expectTypeOf<RpcW6Results["get_trace"]["trace"]>().toEqualTypeOf<Trace>();
    expectTypeOf<SdkAgentSession["trace"]>().toEqualTypeOf<
      ((options?: import("./trace/types.js").TraceOptions) => Trace) | undefined
    >();
  });
});

describe("第六波 ③：Memory", () => {
  it("配置、profile、SDK、命令行；系统节；权限类", () => {
    expectTypeOf<NonNullable<AmaConfig["memory"]>["enabled"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<NonNullable<AmaConfig["memory"]>["subagents"]>().toEqualTypeOf<
      "off" | "read" | undefined
    >();
    expectTypeOf<ProfileFile["memory"]>().toEqualTypeOf<ProfileMemoryOptions | undefined>();
    expectTypeOf<CreateSessionOptions["memory"]>().toEqualTypeOf<
      ProfileMemoryOptions | undefined
    >();
    expectTypeOf<CliConfigOverrides["memory"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<SystemPromptInput["memory"]>().toEqualTypeOf<string | undefined>();
    expect(SECTION_ORDER.indexOf("memory")).toBe(SECTION_ORDER.indexOf("skills") + 1);
    expectTypeOf<ToolPermission>().toEqualTypeOf<"read" | "write" | "execute" | "memory">();
  });
});

describe("第六波 ④：ChatGPT 登录", () => {
  it("KeySource、compat、Usage.billing、quota_update、订阅统计、auth.json 联合类型、auth 配置", () => {
    expectTypeOf<"oauth">().toExtend<KeySource>();
    expectTypeOf<"oauth">().toExtend<RpcModelInfo["keySource"]>();
    expectTypeOf<OpenAIResponsesCompat["chatgptBackend"]>().toEqualTypeOf<
      "siwc" | "codex" | undefined
    >();
    expectTypeOf<OpenAIResponsesCompat["instructionsMode"]>().toEqualTypeOf<
      "native" | "developer-message" | undefined
    >();
    expectTypeOf<OpenAIResponsesCompat["toolsInNamespace"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Usage["billing"]>().toEqualTypeOf<"subscription" | undefined>();
    expectTypeOf<QuotaUpdateEvent>().toExtend<SessionEvent>();
    expectTypeOf<SessionStats["subscription"]>().not.toBeAny();
    expectTypeOf<OAuthAuthEntry>().toExtend<AuthFile["providers"][string]>();
    expectTypeOf<NonNullable<NonNullable<AmaConfig["auth"]>["chatgpt"]>["flavor"]>().toEqualTypeOf<
      "siwc" | "codex" | undefined
    >();
  });
});

describe("第六波 ⑤：界面钩子与配置", () => {
  it("Agent 栏、命令钩子", () => {
    expectTypeOf<UiConfig["agentBar"]>().toEqualTypeOf<"auto" | "off" | undefined>();
    expectTypeOf<UiConfig["replyLanguage"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CommandUi["agentBar"]>().not.toBeUndefined();
    expectTypeOf<CommandUi["traceView"]>().not.toBeUndefined();
    expectTypeOf<CommandUi["memoryPanel"]>().not.toBeUndefined();
    expectTypeOf<CommandUi["configPanel"]>().not.toBeUndefined();
    expectTypeOf<CommandContext["extra"]>().not.toBeUndefined();
  });

  it("协议 / 宿主 / 会话格式版本不变", () => {
    expect(RPC_PROTOCOL_VERSION).toBe(1);
    expect(HOST_API_VERSION).toBe(1);
    expect(SESSION_FORMAT_VERSION).toBe(1);
  });
});
