/**
 * 共享错误类型（设计 §2「错误」）。[B0] 契约文件。
 *
 * 补全说明：设计只给出 `class AmaError extends Error { code; exitCode?; detail? }` 与
 * `StartupError`，未指定文件位置。各层（ai / agent / tools / config / cli）都要抛它，
 * 而 ai 是最底层、不得 import 上层，所以放在 src 根，由 B0 所有。
 * `exitCode` 用数字而不是 `ExitCode` 类型，避免底层模块反向依赖 cli/。
 */

/** 已知错误码；实现可以使用其它字符串，但下列码的语义固定。 */
export type KnownErrorCode =
  | "no_api_key" // 供应商需要 key 而未找到（流函数同步抛出，§3.1）
  | "busy" // 运行中调用 prompt() 且未给 streamingBehavior（§4.3）
  | "aborted"
  | "invalid_arguments" // 参数 / 输入不合法
  | "schema_violation" // 工具输入未通过 JSON Schema 校验
  | "model_not_found"
  | "provider_not_found"
  | "tool_not_found"
  | "tool_exists" // HostApi.tools.register 同名
  | "config_invalid"
  | "profile_invalid"
  | "session_not_found"
  | "session_corrupt"
  | "host_load_failed"
  | "host_version_mismatch"
  | "hook_failed"
  | "not_implemented";

export type ErrorCode = KnownErrorCode | (string & {});

export interface AmaErrorOptions {
  exitCode?: number;
  detail?: unknown;
  cause?: unknown;
}

export class AmaError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number | undefined;
  readonly detail: unknown;

  constructor(code: ErrorCode, message: string, options: AmaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AmaError";
    this.code = code;
    this.exitCode = options.exitCode;
    this.detail = options.detail;
  }
}

/** 启动序列（§11.1）中的错误；`exitCode` 必填，取值见 cli/exit-codes.ts。 */
export class StartupError extends AmaError {
  declare readonly exitCode: number;

  constructor(code: ErrorCode, message: string, exitCode: number, options: AmaErrorOptions = {}) {
    super(code, message, { ...options, exitCode });
    this.name = "StartupError";
  }
}

export function isAmaError(value: unknown): value is AmaError {
  return value instanceof AmaError;
}
