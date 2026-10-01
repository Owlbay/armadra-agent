/**
 * `@armadra/agent/rpc`：RPC（stdio JSONL，`--mode rpc`）命令 / 响应 / 事件类型（设计 §13.2，
 * 框架沿用 v1 §8.4）。[B0] 契约文件，实现归 B6（modes/rpc/、modes/print/json-event.ts）。
 *
 * 补全与偏差：
 * - 设计只列了命令名；参数形状按 v1 §8.4 补全，新增命令（get_available_thinking_levels、
 *   set_auto_retry、abort_retry、get_fork_messages、set_permission_mode、get_commands、
 *   get_skills）按名字含义补全。
 * - 线上事件 = 进程内 `SessionEvent`，但 `message_update` 换成纯增量（去掉 partial / 累计消息，
 *   附最新 usage）；stream-json 输出同一形状。
 * - 类型定义直接放在本文件（B6 实现 import 它），避免子路径入口依赖实现文件。
 */

import type { AssistantEvent, ImageBlock, ModelThinkingLevel, Usage } from "./ai/types.js";
import type { QueueMode, SessionEvent } from "./agent/types.js";
import type { ApprovalDecision, PermissionMode } from "./permissions/types.js";

export type { SessionEvent } from "./agent/types.js";

export const RPC_PROTOCOL_VERSION = 1 as const;

export type RpcCapability = "approvals" | "images" | "hooks";

export interface RpcHello {
  type: "hello";
  protocolVersion: typeof RPC_PROTOCOL_VERSION;
  agent: "ama";
  version: string;
  capabilities: RpcCapability[];
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/** 无参数命令。 */
export type NoParams = Record<never, never>;

export interface RpcCommandMap {
  // 提示
  prompt: { message: string; images?: ImageBlock[]; streamingBehavior?: "steer" | "followUp" };
  steer: { message: string; images?: ImageBlock[] };
  follow_up: { message: string; images?: ImageBlock[] };
  abort: NoParams;
  clear_queue: NoParams;
  // 状态
  get_state: NoParams;
  get_messages: NoParams;
  get_last_assistant_text: NoParams;
  get_session_stats: NoParams;
  // 模型
  set_model: { provider: string; modelId: string };
  get_available_models: NoParams;
  set_thinking_level: { level: ModelThinkingLevel };
  get_available_thinking_levels: NoParams;
  // 队列
  set_steering_mode: { mode: QueueMode };
  set_follow_up_mode: { mode: QueueMode };
  // 压缩
  compact: { customInstructions?: string };
  set_auto_compaction: { enabled: boolean };
  // 重试
  set_auto_retry: { enabled: boolean };
  abort_retry: NoParams;
  // 会话
  new_session: { parentSession?: string };
  switch_session: { sessionPath: string };
  fork: { entryId: string };
  get_entries: { since?: string };
  get_tree: NoParams;
  set_session_name: { name: string };
  get_fork_messages: NoParams;
  // 审批
  set_client_capabilities: { capabilities: RpcCapability[] };
  permission_response: { requestId: string; decision: ApprovalDecision };
  // 工具 / 权限 / 发现
  get_tools: NoParams;
  set_active_tools: { names: string[] };
  set_permission_mode: { mode: PermissionMode };
  get_commands: NoParams;
  get_skills: NoParams;
}

export type RpcCommandType = keyof RpcCommandMap;

/** `{ id?, type, ...参数 }`。 */
export type RpcCommand = {
  [K in RpcCommandType]: { id?: string; type: K } & RpcCommandMap[K];
}[RpcCommandType];

export type RpcCommandOf<K extends RpcCommandType> = Extract<RpcCommand, { type: K }>;

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

export interface RpcModelInfo {
  provider: string;
  id: string;
  name: string;
  /** 只报有无，不回密钥。 */
  hasKey: boolean;
  keySource: "cli" | "auth-file" | "config" | "env" | "none";
  contextWindow?: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
}

export interface RpcCommandInfo {
  name: string;
  description?: string;
  source: "builtin" | "template" | "skill";
}

export interface RpcSuccessResponse<D = unknown> {
  id?: string;
  type: "response";
  command: RpcCommandType;
  success: true;
  data?: D;
}

export interface RpcErrorResponse {
  id?: string;
  type: "response";
  /** JSON 解析失败时为 "parse" 且无 id。 */
  command: RpcCommandType | "parse";
  success: false;
  error: string;
  /** AmaError.code（若有）。 */
  code?: string;
}

export type RpcResponse<D = unknown> = RpcSuccessResponse<D> | RpcErrorResponse;

/** prompt / steer / follow_up 的 data。 */
export interface RpcPromptData {
  disposition: "started" | "queued" | "handled";
}

// ---------------------------------------------------------------------------
// 事件（线上形状）
// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 线上助手事件：去掉 partial；done / error 仍带最终 message。 */
export type WireAssistantEvent = DistributiveOmit<AssistantEvent, "partial">;

export interface WireMessageUpdate {
  type: "message_update";
  assistantMessageEvent: WireAssistantEvent;
  /** 最新 usage（供应商流中可得时）。 */
  usage?: Usage;
}

export type RpcEvent = Exclude<SessionEvent, { type: "message_update" }> | WireMessageUpdate;

export type RpcEventType = RpcEvent["type"];

/** stdout 上的一行。 */
export type RpcOutbound = RpcHello | RpcResponse | RpcEvent;
