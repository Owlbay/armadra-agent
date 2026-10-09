/**
 * `@armadra/agent/rpc`：RPC（stdio JSONL，`--mode rpc`）命令 / 响应 / 事件类型（设计 §13.2，
 * 框架沿用 v1 §8.4）。[B0] 契约文件，实现归 B6（modes/rpc/、modes/print/json-event.ts）。
 *
 * 补全与偏差：
 * - 设计只列了命令名；参数形状按 v1 §8.4 补全，新增命令（get_available_thinking_levels、
 *   set_auto_retry、abort_retry、get_fork_messages、set_permission_mode、get_commands、
 *   get_skills）按名字含义补全。
 * - [RW-B] 回滚：get_rewind_points → `{ points }`、rewind → `RewindResult`（形状见
 *   checkpoints/types.ts）、summarize_from → `{ leafId, draft, summary? }`、summarize_up_to →
 *   `CompactionResult`；成功回滚发 `session_rewound` 事件。
 * - 线上事件 = 进程内 `SessionEvent`，但 `message_update` 换成纯增量（去掉 partial / 累计消息，
 *   附最新 usage）；stream-json 输出同一形状。
 * - 类型定义直接放在本文件（B6 实现 import 它），避免子路径入口依赖实现文件。
 * - [W5-C0] 第五波（docs/wave5-plan.md §6.5、§7.5）：命令 `plan_response / get_plan / get_todos /
 *   get_tasks / get_agents`（返回形状见 `RpcW5Results`），客户端能力 `plans`（声明后计划审批交客户端）；
 *   新事件由 `SessionEvent` 派生自动包含。命令实现归 W5-F（C0 时返回 `not_implemented`），
 *   `RPC_PROTOCOL_VERSION` 不变。
 * - [W6-C0] 第六波（docs/wave6-plan.md §2.6、§4.4）：命令 `get_trace`（参数 `RpcGetTraceParams`、返回
 *   `RpcW6Results`，W6-T2 实现，之前回 `not_implemented`）；事件 `quota_update`；`permission_request.context`
 *   可带 `toolCallId`；`keySource` 可为 `oauth`。`RPC_PROTOCOL_VERSION` 不变。
 * - [W7-B2] 后台子 Agent（docs/agents-concurrency-plan.md §2.5）：命令 `background_task { taskId? }` →
 *   `RpcW7Results`（无 taskId = 全部前台运行中任务；对已结束 / 已在后台的任务回空表）；事件
 *   `subagent_background` 由 `SessionEvent` 派生。`RPC_PROTOCOL_VERSION` 不变。
 */

import type { AssistantEvent, ImageBlock, ModelThinkingLevel, Usage } from "./ai/types.js";
import type {
  PlanData,
  PlanDecisionKind,
  QueueMode,
  SessionEvent,
  TodoItemView,
} from "./agent/types.js";
import type { AgentInfo } from "./agents/types.js";
import type { TaskInfo } from "./tools/types.js";
import type { RewindRequest } from "./checkpoints/types.js";
import type { ApprovalDecision, PermissionMode } from "./permissions/types.js";
import type { TracePreview } from "./trace/preview.js";
import type { Trace, TraceSubagentNode } from "./trace/types.js";

export type { SessionEvent } from "./agent/types.js";

export const RPC_PROTOCOL_VERSION = 1 as const;

/** `plans`（W5-C0）：客户端声明后计划审批交给客户端（`plan_proposed` → `plan_response`）。 */
export type RpcCapability = "approvals" | "images" | "hooks" | "plans" | "compact_events";
// hello.capabilities 由 M-G 加入 "compact_events"（C0 不改 RPC_CAPABILITIES，黄金不变）

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
  /**
   * `interrupt: true`：运行中中止当前回合（工具按 abort 收尾），立刻以「排队的 steer + 本条」开新回合
   * （user 消息 origin `interrupt`），应答 `started`；空闲时等同不填。优先于 `streamingBehavior`。
   */
  prompt: {
    message: string;
    images?: ImageBlock[];
    streamingBehavior?: "steer" | "followUp";
    interrupt?: boolean;
  };
  /** `interrupt: true` 同 `prompt`。 */
  steer: { message: string; images?: ImageBlock[]; interrupt?: boolean };
  follow_up: { message: string; images?: ImageBlock[] };
  abort: NoParams;
  clear_queue: NoParams;
  // 状态
  get_state: NoParams;
  get_messages: NoParams;
  get_last_assistant_text: NoParams;
  get_session_stats: NoParams;
  // 模型
  /** `channel`：多渠道供应商的渠道名（缺省走模型的首选渠道）。 */
  set_model: { provider: string; modelId: string; channel?: string };
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
  // 回滚（docs/rewind-plan.md §5）
  get_rewind_points: NoParams;
  rewind: RewindRequest;
  summarize_from: { entryId: string; instructions?: string };
  summarize_up_to: { entryId: string; instructions?: string };
  // 审批
  set_client_capabilities: { capabilities: RpcCapability[] };
  permission_response: { requestId: string; decision: ApprovalDecision };
  // 工具 / 权限 / 发现
  get_tools: NoParams;
  set_active_tools: { names: string[] };
  set_permission_mode: { mode: PermissionMode };
  get_commands: NoParams;
  get_skills: NoParams;
  // [W5-C0] 计划 / 任务（docs/wave5-plan.md §6.5、§7.5）
  plan_response: RpcPlanResponse;
  get_plan: { planId?: string };
  get_todos: NoParams;
  get_tasks: NoParams;
  get_agents: NoParams;
  // [W6-C0] 轨迹（docs/wave6-plan.md §2.6；W6-T2 实现，之前回 not_implemented）
  get_trace: RpcGetTraceParams;
  // [W7-B2] 前台任务转后台（docs/agents-concurrency-plan.md §2.5）
  background_task: { taskId?: string };
}

/** [W7-B2] 第七波命令成功时的 `data` 形状。 */
export interface RpcW7Results {
  /** 实际转了后台的 taskId（含被打断的 `task_ctl wait`）；没有可转的为空表。 */
  background_task: { backgrounded: string[] };
}

/** [W6-C0] `get_trace` 的参数。 */
export interface RpcGetTraceParams {
  /** 缺省 leaf。 */
  branch?: "leaf" | "all";
  /** 尾部优先的回合数，缺省 50，上限 500。 */
  turnLimit?: number;
  /** 回合游标（turn id），向前翻页。 */
  before?: string;
  /** 条目游标（同 `get_entries.since`）：只返回从包含该条目的回合起的回合。 */
  since?: string;
  /** 该任务的子轨迹（ama 子会话或外部骨架）。 */
  taskId?: string;
  /** 缺省 none（只有结构与数字）。 */
  content?: "none" | "preview";
}

/** [W6-C0] 第六波命令成功时的 `data` 形状；错误 `task_not_found` / `invalid_arguments`。 */
export interface RpcW6Results {
  get_trace: {
    trace: Trace;
    hasMoreBefore: boolean;
    cursor: { before?: string; since: string };
    leafId: string | null;
    /** [W6-T2] `taskId` 时：子 Agent 节点本身（不含 `child`；外部 Agent 的骨架在 `external`）。 */
    task?: TraceSubagentNode;
    /** [W6-T2] `content:"preview"` 时：`<kind>:<id>` → 已脱敏、已截断的正文预览（只含窗口内节点）。 */
    previews?: Record<string, TracePreview>;
  };
}

/** [W5-C0] 计划审批的回答（与 `permission_response` 同构）。 */
export interface RpcPlanResponse {
  planId: string;
  decision: PlanDecisionKind;
  /** `approve` 时指定执行模式（缺省回到进入 plan 前的模式）。 */
  mode?: PermissionMode;
  /** `revise`：修改意见（作为普通 user 消息，留在 plan）。 */
  feedback?: string;
  /** 客户端改过的计划全文（version + 1）。 */
  editedMarkdown?: string;
}

/** [W5-C0] 第五波命令成功时的 `data` 形状。 */
export interface RpcW5Results {
  plan_response: { planId: string; decision: PlanDecisionKind };
  get_plan: PlanData | null;
  get_todos: { items: TodoItemView[] };
  get_tasks: { tasks: TaskInfo[] };
  get_agents: { agents: AgentInfo[] };
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
  /** [W6-C0] 加 `oauth`（ChatGPT 登录，W6-O）。 */
  keySource: "cli" | "auth-file" | "config" | "env" | "oauth" | "none";
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
