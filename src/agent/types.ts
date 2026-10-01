/**
 * 循环与会话对象契约（设计 §4.1、§4.3、§13.1、§13.2 事件）。[B0] 契约文件，实现归 B2。
 *
 * 补全与偏差：
 * - `ContentBlock / Usage / StopReason` 等定义在 ai/types.ts，`AgentMessage` 定义在
 *   session/types.ts（依赖方向），此处再导出，设计里「agent/types.ts 提供」的名字都能从这里拿到。
 * - `LoopHooks.beforeToolCall` 的 `ctx` 补全为 `ToolCallGateContext`；`prepareRequest` 的
 *   `req` 补全为 `PreparedRequest`。
 * - `SessionEvent` 是 AgentSession.subscribe 的进程内事件；RPC / stream-json 线上形状见
 *   src/rpc.ts（`message_update` 线上为纯增量）。
 * - `AgentSession` 是接口；B2 的实现类不要再叫 `AgentSession`（建议 `AgentSessionImpl`），
 *   否则与本接口在 index.ts 的再导出冲突。
 * - 补全 `SessionState`、`SessionStats`、`CompactionResult`、`CompactionSettings`、
 *   `RetrySettings`、`QueueMode`。
 * - （B2 追加）`PromptOptions.origin` 与 `steer / followUp` 的可选 `EnqueueOptions`：宿主
 *   `sendUser(text, origin)` 注入的消息要以 `origin` 落盘（§4.3）；`"user"` 等同不填。
 */

import type {
  AssistantEvent,
  AssistantMessage,
  ImageBlock,
  Message,
  MessageOrigin,
  Model,
  ModelRef,
  ModelThinkingLevel,
  ToolCallBlock,
  ToolResultMessage,
  TranscriptContext,
  Usage,
} from "../ai/types.js";
import type { HookEvent } from "../hooks/types.js";
import type { ApprovalDecision, ApprovalReason, PermissionMode } from "../permissions/types.js";
import type { AgentMessage, SessionEntry } from "../session/types.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";

export type {
  AssistantContentBlock,
  AssistantMessage,
  ContentBlock,
  ImageBlock,
  Message,
  StopReason,
  SystemMessage,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../ai/types.js";
export type {
  AgentMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
} from "../session/types.js";

export type ToolCall = ToolCallBlock;

// ---------------------------------------------------------------------------
// 循环钩子点（§4.1）
// ---------------------------------------------------------------------------

export interface TurnResult {
  assistant: AssistantMessage;
  toolResults: ToolResultMessage[];
}

export interface PreparedRequest {
  context: TranscriptContext;
  model: Model;
  thinkingLevel: ModelThinkingLevel;
}

export interface ToolCallGateContext {
  readonly signal: AbortSignal;
  /** 产出该调用的助手消息。 */
  readonly assistant: AssistantMessage;
  /** 找不到工具时为 undefined（tool-runner 已先行报错，通常不会走到钩子）。 */
  readonly tool: ToolDefinition | undefined;
}

export interface ToolCallGate {
  block?: boolean;
  reason?: string;
  /** Hook 的 updatedInput 替换后的输入。 */
  input?: unknown;
}

export interface LoopHooks {
  /** 档一裁剪、Hook 的 additionalContext 注入。 */
  transformContext?(messages: AgentMessage[], signal: AbortSignal): Promise<AgentMessage[]>;
  /** 不得抛错。 */
  convertToLlm(messages: AgentMessage[]): Message[];
  prepareRequest?(req: PreparedRequest): Promise<PreparedRequest>;
  /** 阈值压缩在此。 */
  prepareNextTurn?(prev: TurnResult): Promise<void>;
  /** 命令式 Hook PreToolUse → 权限管线 → broker。 */
  beforeToolCall(call: ToolCall, ctx: ToolCallGateContext): Promise<ToolCallGate>;
  /** PostToolUse 可追加上下文 / 改为错误。 */
  afterToolCall?(call: ToolCall, result: ToolResult): Promise<ToolResult>;
  finishTurn?(turn: TurnResult): Promise<"continue" | "end">;
  getSteeringMessages(): AgentMessage[];
  getFollowUpMessages(): AgentMessage[];
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

export type QueueMode = "one-at-a-time" | "all";

export interface CompactionSettings {
  enabled: boolean;
  /** 缺省 16 384。 */
  reserveTokens: number;
  /** 缺省 20 000。 */
  keepRecentTokens: number;
}

export interface RetrySettings {
  enabled: boolean;
  /** 缺省 3。 */
  maxRetries: number;
  /** 缺省 2 000。 */
  baseDelayMs: number;
  /** 缺省 60 000。 */
  maxDelayMs: number;
}

// ---------------------------------------------------------------------------
// 会话事件（进程内）
// ---------------------------------------------------------------------------

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  tokensAfter?: number;
  usage?: Usage;
}

export type CompactionTrigger = "threshold" | "overflow" | "manual";

export type SessionEvent =
  | {
      type: "session_start";
      sessionId: string;
      sessionFile?: string;
      cwd: string;
      reason: "startup" | "resume" | "new" | "fork";
    }
  | { type: "agent_start" }
  | { type: "agent_end"; stopReason: string; willRetry: boolean }
  | { type: "agent_before_settle" }
  | { type: "agent_settled"; warning?: string }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      /** 当前累计的部分消息。 */
      message: AssistantMessage;
      assistantMessageEvent: AssistantEvent;
    }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partial: string }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: ToolResult;
      isError: boolean;
    }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; trigger: CompactionTrigger }
  | {
      type: "compaction_end";
      trigger: CompactionTrigger;
      result?: CompactionResult;
      aborted: boolean;
      willRetry: boolean;
      error?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      input: unknown;
      reason: ApprovalReason;
      hookReason?: string;
      timeoutMs: number;
    }
  | { type: "permission_resolved"; requestId: string; decision: ApprovalDecision }
  | { type: "permission_mode_changed"; mode: PermissionMode }
  | { type: "entry_appended"; entry: SessionEntry }
  | {
      type: "hook_executed";
      event: HookEvent;
      command: string;
      exitCode: number | null;
      durationMs: number;
    }
  | { type: "session_changed"; sessionId: string; sessionFile?: string }
  | { type: "model_changed"; model: ModelRef }
  | { type: "thinking_level_changed"; level: ModelThinkingLevel };

export type SessionEventType = SessionEvent["type"];

// ---------------------------------------------------------------------------
// AgentSession（§13.1）
// ---------------------------------------------------------------------------

export type PromptDisposition = "started" | "queued" | "handled";

export interface PromptOptions {
  images?: ImageBlock[];
  streamingBehavior?: "steer" | "followUp";
  /** 落盘到 user 消息的 origin（宿主注入为 "host"）；缺省：空闲时不填，入队时为 streamingBehavior。 */
  origin?: MessageOrigin;
}

/** steer / followUp 的可选项。 */
export interface EnqueueOptions {
  /** 缺省为 "steer" / "followUp"；`"user"` 表示普通用户输入（不写 origin）。 */
  origin?: MessageOrigin;
}

export interface SessionState {
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  model: ModelRef | undefined;
  thinkingLevel: ModelThinkingLevel;
  permissionMode: PermissionMode;
  sessionId: string;
  sessionFile: string | undefined;
  cwd: string;
  sessionName: string | undefined;
  messageCount: number;
  pendingMessageCount: number;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  autoCompaction: boolean;
  autoRetry: boolean;
}

export interface SessionStats {
  sessionId: string;
  sessionFile: string | undefined;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** 美元；任一条消息缺成本时 undefined（显示 `$?`）。 */
  cost: number | undefined;
  /** 估算的当前上下文 token（§9 估算）。 */
  contextTokens: number | undefined;
  contextWindow: number | undefined;
  /** 0–100；无窗口时 undefined（显示 `ctx ?`）。 */
  contextPercent: number | undefined;
}

export interface AgentSession {
  /** 运行中且无 streamingBehavior → reject AmaError{code:"busy"}；run 结束（含重试与 followUp）后 resolve。 */
  prompt(text: string, options?: PromptOptions): Promise<PromptDisposition>;
  steer(text: string, options?: EnqueueOptions): Promise<"queued" | "handled">;
  followUp(text: string, options?: EnqueueOptions): Promise<"queued" | "handled">;
  /** 回到 idle 后 resolve；不清队列。 */
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  clearQueue(): { steering: string[]; followUp: string[] };
  subscribe(listener: (event: SessionEvent) => void): () => void;
  compact(instructions?: string): Promise<CompactionResult>;
  fork(entryId: string): Promise<AgentSession>;
  /** `provider/model-id`。 */
  setModel(ref: string): Promise<void>;
  setThinkingLevel(level: ModelThinkingLevel): void;
  setPermissionMode(mode: PermissionMode): void;
  setActiveTools(names: string[]): void;
  getTools(): readonly ToolDefinition[];
  readonly state: SessionState;
  readonly messages: readonly AgentMessage[];
  readonly entries: readonly SessionEntry[];
  getLastAssistantText(): string | null;
  getStats(): SessionStats;
  dispose(): Promise<void>;
}
