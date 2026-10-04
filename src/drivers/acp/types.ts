/**
 * ACP（Agent Client Protocol）v1 的子集类型（docs/wave5-plan.md §5.1，D14）。[W5-E]
 *
 * 手写、零依赖；只收 ama 作为客户端（驱动外部 Agent）与服务端（`ama --mode acp`）两侧用到的部分：
 * `initialize`、`session/new|load|resume|list|close`、`session/prompt|cancel|set_mode|set_config_option`、
 * `session/update`（含 `usage_update`）、`session/request_permission`、`elicitation/create`。字段名与规范一致（camelCase），
 * 未知字段一律保留不报错；`_meta` 不解释。
 *
 * 不声明 `fs` / `terminal` 客户端能力（与 Armadra Q5 一致）：外部 Agent 自己读写、自己跑命令，
 * 用它自己的权限策略；它要问人的才经 `session/request_permission` 回到 ama。
 */

import type { AcpToolKind } from "../types.js";

export const ACP_PROTOCOL_VERSION = 1 as const;

/** 方法名（客户端 → Agent 的请求 / 通知，Agent → 客户端的请求 / 通知）。 */
export const ACP_METHODS = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionClose: "session/close",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetConfigOption: "session/set_config_option",
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
  elicitationCreate: "elicitation/create",
} as const;

/** JSON-RPC 错误码（规范沿用 JSON-RPC 2.0；`-32000` 为 ACP 的 auth_required）。 */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

// ---------------------------------------------------------------------------
// 内容块
// ---------------------------------------------------------------------------

export interface AcpTextContent {
  type: "text";
  text: string;
}
export interface AcpImageContent {
  type: "image";
  /** base64。 */
  data: string;
  mimeType: string;
  uri?: string;
}
export interface AcpResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
  title?: string;
  description?: string;
  size?: number;
}
export interface AcpEmbeddedResource {
  type: "resource";
  resource: { uri: string; text?: string; blob?: string; mimeType?: string };
}
export type AcpContentBlock =
  AcpTextContent | AcpImageContent | AcpResourceLink | AcpEmbeddedResource;

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface AcpImplementationInfo {
  name: string;
  title?: string;
  version: string;
}

export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  /** 能接 `elicitation/create`（存在即支持）。 */
  elicitation?: Record<string, unknown>;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: AcpClientCapabilities;
  clientInfo?: AcpImplementationInfo;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  /** 2026 年稳定进 v1 的会话能力（存在即支持）。 */
  sessionCapabilities?: {
    list?: Record<string, unknown> | null;
    resume?: Record<string, unknown> | null;
    close?: Record<string, unknown> | null;
  };
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: AcpAuthMethod[];
  agentInfo?: AcpImplementationInfo;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/** `session/new.mcpServers[].env` 的一项。 */
export type AcpEnvVariable = { name: string; value: string };

/** stdio 传输的 MCP 服务器：ACP v1 要求每个 Agent 都支持这一种。 */
export type AcpStdioMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: AcpEnvVariable[];
};

/**
 * 交给外部 Agent 的 MCP 服务器。ama 自己不加（Skills 不做 MCP），缺省是空数组；宿主（如 Armadra）
 * 经 {@link AcpSessionOptions} 传入的原样转发，http / sse 变体不在这里解释。
 */
export type AcpMcpServer = AcpStdioMcpServer | Record<string, unknown>;

/** `AcpClient.newSession` / `resumeSession` / `loadSession` 的可选项。 */
export interface AcpSessionOptions {
  /** 随 `session/new|resume|load` 发给 Agent；缺省空数组。 */
  mcpServers?: readonly AcpMcpServer[];
}

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionMode[];
}

export interface AcpNewSessionParams {
  cwd: string;
  mcpServers: AcpMcpServer[];
}
export interface AcpNewSessionResult {
  sessionId: string;
  modes?: AcpSessionModeState | null;
  configOptions?: AcpSessionConfigOption[] | null;
}

export interface AcpLoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers: AcpMcpServer[];
}
export interface AcpLoadSessionResult {
  modes?: AcpSessionModeState | null;
  configOptions?: AcpSessionConfigOption[] | null;
}

// ---------------------------------------------------------------------------
// 会话配置项（`configOptions`、`session/set_config_option`）
// ---------------------------------------------------------------------------

/** 配置项里一个可选值。 */
export interface AcpConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

/** 规范允许把可选值分组。 */
export interface AcpConfigSelectGroup {
  group: string;
  name: string;
  options: AcpConfigSelectOption[];
}

/** `session/new|load|resume` 答的 `configOptions[]` 的一项（目前规范只有 `select`）。 */
export interface AcpSessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  /** `mode` / `model` / `thought_level`，或 Agent 自己的。 */
  category?: string | null;
  type: "select" | (string & {});
  currentValue: string;
  options: (AcpConfigSelectOption | AcpConfigSelectGroup)[];
}

export interface AcpSetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string;
}

/** 答复带全部配置项的新状态（改一项可能连带别的）。 */
export interface AcpSetConfigOptionResult {
  configOptions?: AcpSessionConfigOption[] | null;
}

// ---------------------------------------------------------------------------
// elicitation（Agent 向人要结构化输入）
// ---------------------------------------------------------------------------

/** 表单里的一个字段：扁平的原始类型，规范只允许这几种。 */
export type AcpElicitationField =
  | {
      type: "string";
      title?: string;
      description?: string;
      enum?: string[];
      enumNames?: string[];
      format?: string;
      minLength?: number;
      maxLength?: number;
      default?: string;
    }
  | {
      type: "number" | "integer";
      title?: string;
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | { type: "boolean"; title?: string; description?: string; default?: boolean };

export interface AcpElicitationSchema {
  type: "object";
  properties: Record<string, AcpElicitationField>;
  required?: string[];
}

/** Agent 发来的 `elicitation/create` 参数；未知字段保留。 */
export interface AcpElicitationParams {
  sessionId?: string;
  message: string;
  /** `form`（缺省）或 `url`。 */
  mode?: "form" | "url" | (string & {});
  requestedSchema?: AcpElicitationSchema;
  url?: string;
  [key: string]: unknown;
}

export type AcpElicitationAction = "accept" | "decline" | "cancel";

export interface AcpElicitationResult {
  action: AcpElicitationAction;
  /** 只随 `accept`。 */
  content?: Record<string, string | number | boolean>;
}

export type AcpResumeSessionParams = AcpLoadSessionParams;
export type AcpResumeSessionResult = AcpLoadSessionResult;

export interface AcpListSessionsParams {
  cwd?: string;
  cursor?: string;
}
export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}
export interface AcpListSessionsResult {
  sessions: AcpSessionInfo[];
  nextCursor?: string | null;
}

export interface AcpCloseSessionParams {
  sessionId: string;
}

export interface AcpSetModeParams {
  sessionId: string;
  modeId: string;
}

// ---------------------------------------------------------------------------
// 回合
// ---------------------------------------------------------------------------

export type AcpStopReason =
  "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

/** 本回合用量（可选字段，按 2026-06 稳定的 usage 提案）。 */
export interface AcpPromptUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export interface AcpPromptResult {
  stopReason: AcpStopReason;
  usage?: AcpPromptUsage | null;
}

export interface AcpCancelParams {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// session/update
// ---------------------------------------------------------------------------

export type { AcpToolKind };

export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpToolCallLocation {
  path: string;
  line?: number | null;
}

export type AcpToolCallContent =
  | { type: "content"; content: AcpContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface AcpToolCall {
  toolCallId: string;
  title: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** `tool_call_update` 与权限请求里的 toolCall：除 id 外都可缺。 */
export type AcpToolCallUpdate = Partial<AcpToolCall> & { toolCallId: string };

export interface AcpPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export type AcpSessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpContentBlock }
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCallUpdate)
  | { sessionUpdate: "plan"; entries: AcpPlanEntry[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | {
      sessionUpdate: "usage_update";
      /** 当前上下文已用 token。 */
      used: number;
      /** 上下文窗口。 */
      size: number;
      cost?: { amount: number; currency: string } | null;
    }
  | {
      sessionUpdate: "available_commands_update";
      availableCommands: { name: string; description: string }[];
    }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null };

export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

// ---------------------------------------------------------------------------
// session/request_permission（Agent → 客户端）
// ---------------------------------------------------------------------------

export type AcpPermissionOptionKind =
  "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

export interface AcpRequestPermissionResult {
  outcome: AcpPermissionOutcome;
}
