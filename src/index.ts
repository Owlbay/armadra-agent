/**
 * `@armadra/agent`：SDK 公开面（设计 §13.1）。[B0] 所有。
 *
 * B0 导出契约类型与少量契约内的值（版本、错误、校验器、退出码）；「SDK」段（B6）导出
 * `createAgentSession`、`createRuntime` 与常用实现类。
 */

// 值
export { AMA_VERSION } from "./version.js";
export { AmaError, StartupError, isAmaError } from "./errors.js";
export { HOST_API_VERSION } from "./host/types.js";
export { RPC_PROTOCOL_VERSION } from "./rpc.js";
export { SESSION_FORMAT_VERSION } from "./session/types.js";
export { HOOK_EVENTS } from "./hooks/types.js";
export { REWIND_NOTE_CUSTOM_TYPE } from "./checkpoints/types.js";
export { PERMISSION_MODES_STRICT_FIRST } from "./permissions/types.js";
export { ExitCode, describeExitCode } from "./cli/exit-codes.js";
export { defineTool } from "./tools/types.js";
export { validateSchema, checkSchemaSubset, formatSchemaErrors } from "./agent/schema.js";
export type { SchemaError, SchemaErrorKeyword } from "./agent/schema.js";

// 契约类型
export type * from "./ai/types.js";
export type * from "./ai/cache/types.js";
export type * from "./agent/types.js";
export type * from "./session/types.js";
export type * from "./tools/types.js";
export type * from "./hooks/types.js";
export type * from "./permissions/types.js";
export type * from "./host/types.js";
export type * from "./config/types.js";
export type * from "./checkpoints/types.js";
// [W6-C0] 轨迹（docs/wave6-plan.md §2.1）与界面语言
export type * from "./trace/types.js";
export { TRACE_CUSTOM_TYPE } from "./trace/types.js";
export type { Locale } from "./i18n/index.js";
export type { AmaErrorOptions, ErrorCode, KnownErrorCode } from "./errors.js";
export type {
  Runtime,
  RuntimeMode,
  ResolvedPaths,
  TrustState,
  LoadedResources,
} from "./cli/runtime.js";

// SDK（B6 追加）
export { createAgentSession, createRuntime } from "./sdk.js";
export type { CreateSessionOptions, RuntimeOptions, SessionAuth } from "./sdk.js";
// [W5-Z] 计划（docs/plan.md「SDK」）：`createAgentSession({ plan })` 与 `session.plan` 的类型。
export type {
  PlanDecision,
  PlanResponse,
  PlanResponseResult,
  SdkAgentSession,
  SessionPlanApi,
  SessionPlanOptions,
} from "./sdk.js";
export { AgentSessionImpl } from "./agent/session.js";
export { SessionManager } from "./session/manager.js";
export { ProviderRegistry } from "./ai/providers/registry.js";
export { FakeProvider } from "./ai/fake/fake-provider.js";
export { loadConfigFile as loadConfig } from "./config/load.js";
export { createToolRegistry } from "./tools/registry.js";
export { PRESET_TOOLS, effectiveCodemodeMode } from "./tools/presets.js";
export { createRuntimeDeps, DEFAULT_TOOL_FACTORIES } from "./cli/compose.js";
export type { ComposeOptions, ToolFactory, ToolFactoryContext } from "./cli/compose.js";
export { currentSession, switchSession } from "./cli/compose-session.js";
export type { SwitchRequest } from "./cli/compose-session.js";
