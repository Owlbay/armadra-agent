/**
 * `@armadra/agent`：SDK 公开面（设计 §13.1）。[B0] 所有。
 *
 * B0 只导出契约类型与少量契约内的值（版本、错误、校验器、退出码）。B6 完成 sdk.ts 后在
 * 「SDK」段追加 `createAgentSession`、`createRuntime`，B1 / B2 / B5 的
 * `ProviderRegistry`、`FakeProvider`、`SessionManager`、`loadConfig` 也由 B6 在此统一再导出。
 */

// 值
export { AMA_VERSION } from "./version.js";
export { AmaError, StartupError, isAmaError } from "./errors.js";
export { HOST_API_VERSION } from "./host/types.js";
export { RPC_PROTOCOL_VERSION } from "./rpc.js";
export { SESSION_FORMAT_VERSION } from "./session/types.js";
export { HOOK_EVENTS } from "./hooks/types.js";
export { PERMISSION_MODES_STRICT_FIRST } from "./permissions/types.js";
export { ExitCode, describeExitCode } from "./cli/exit-codes.js";
export { defineTool } from "./tools/types.js";
export { validateSchema, checkSchemaSubset, formatSchemaErrors } from "./agent/schema.js";
export type { SchemaError, SchemaErrorKeyword } from "./agent/schema.js";

// 契约类型
export type * from "./ai/types.js";
export type * from "./agent/types.js";
export type * from "./session/types.js";
export type * from "./tools/types.js";
export type * from "./hooks/types.js";
export type * from "./permissions/types.js";
export type * from "./host/types.js";
export type * from "./config/types.js";
export type { AmaErrorOptions, ErrorCode, KnownErrorCode } from "./errors.js";
export type {
  Runtime,
  RuntimeMode,
  ResolvedPaths,
  TrustState,
  LoadedResources,
} from "./cli/runtime.js";

// SDK（B6 追加）
