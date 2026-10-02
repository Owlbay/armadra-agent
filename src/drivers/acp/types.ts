/**
 * ACP（Agent Client Protocol）v1 的子集类型（docs/wave5-plan.md §5.1，D14）。[W5-E]
 *
 * 手写、零依赖；只收 ama 作为客户端（驱动外部 Agent）与服务端（`ama --mode acp`）两侧用到的部分：
 * `initialize`、`session/new|load|resume|list|close`、`session/prompt|cancel|set_mode`、
 * `session/update`（含 `usage_update`）、`session/request_permission`。字段名与规范一致（camelCase），
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
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
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

/** ama 不向外部 Agent 传 MCP 服务器（Skills 不做 MCP），总是空数组。 */
export type AcpMcpServer = Record<string, unknown>;

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
}

export interface AcpLoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers: AcpMcpServer[];
}
export interface AcpLoadSessionResult {
  modes?: AcpSessionModeState | null;
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
