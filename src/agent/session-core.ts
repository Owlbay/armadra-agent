/**
 * AgentSessionImpl 的装配选项与内部协作接口。[B2]
 *
 * `AgentSessionOptions` 是集成者（B5 bootstrap / B6 sdk）构造会话时注入的全部依赖；
 * `SessionCore` 是 session.ts 交给 session-tools.ts / session-compaction.ts 的内部视图（避免循环 import）。
 */

import type { Model, ModelThinkingLevel, ProviderRegistryApi } from "../ai/types.js";
import type {
  HookDispatcherApi,
  HookEvent,
  HookEventPayload,
  HookOutcome,
} from "../hooks/types.js";
import type { ApprovalBroker, PermissionPipelineApi } from "../permissions/types.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionEntry, SessionEntryInput } from "../session/types.js";
import type { SubagentRequest, SubagentResult, ToolDefinition } from "../tools/types.js";
import type { Agent } from "./agent.js";
import type { StreamFn } from "./loop.js";
import type { SystemPromptInput } from "./system-prompt.js";
import type { CompactionSettings, QueueMode, RetrySettings, SessionEvent } from "./types.js";

export type PromptExpansion = { text: string } | { handled: true };

export interface AgentSessionOptions {
  sessionManager: SessionManager;
  /** 供应商注册表：getApi / resolveApiKey / findModel（setModel 与子 Agent 用）。 */
  providers: ProviderRegistryApi;
  model: Model;
  thinkingLevel?: ModelThinkingLevel;
  /** 全部可用工具（内置 + 宿主 + SDK）。 */
  tools?: readonly ToolDefinition[];
  /** 活动集；缺省 = tools 全部。 */
  activeTools?: readonly string[];
  /** 权限管线（B3）；缺省 = 全部放行。 */
  permission?: PermissionPipelineApi;
  /** 审批回答者链：宿主 broker → UI broker；都返回 undefined → deny（无人值守）。 */
  brokers?: readonly ApprovalBroker[];
  /** 无人值守：权限管线把 ask 变 deny。 */
  unattended?: boolean;
  /** 审批超时，缺省 10 分钟（超时 deny）。 */
  approvalTimeoutMs?: number;
  /** 命令式 Hook（B5）；缺省无 Hook。 */
  hooks?: HookDispatcherApi;
  /** 系统提示的静态部分（工具与 cwd 由会话填）。 */
  system?: Omit<SystemPromptInput, "tools" | "cwd">;
  compaction?: Partial<CompactionSettings>;
  retry?: Partial<RetrySettings>;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  /** 模板 / `/skill:` 展开（B3 / B7）；`handled` = 已作为命令处理，不进模型。 */
  expandPrompt?(text: string): Promise<PromptExpansion>;
  /** 溢出文案识别（B1 的 ai/overflow.ts）；缺省用 retry.ts 内置正则。 */
  isContextOverflow?(errorMessage: string): boolean;
  /** 缺省 30 000。 */
  maxToolResultChars?: number;
  /** abort 后等待工具自行结束的上限，缺省 3 000 ms。 */
  abortGraceMs?: number;
  /** 截断全文目录；缺省 `<会话文件目录>/outputs`，内存会话 undefined。 */
  outputDir?: string;
  /** task 深度：主会话 0。 */
  depth?: number;
  /** 子 Agent 的回合上限（maxTurns）。 */
  maxTurns?: number;
  /** 子 Agent 并发上限，缺省 4；`false` 关闭 spawnSubagent。 */
  subagents?: { maxConcurrent?: number } | false;
  /** 宿主适配器 id（写进 HookInput.host）。 */
  hostId?: string;
  log?(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface SessionCore {
  readonly options: AgentSessionOptions;
  readonly manager: SessionManager;
  readonly agent: Agent;
  readonly cwd: string;
  readonly depth: number;
  readonly readFiles: Set<string>;
  model(): Model;
  thinkingLevel(): ModelThinkingLevel;
  outputDir(): string | undefined;
  stream: StreamFn;
  resolveApiKey(): Promise<string | undefined>;
  emit(event: SessionEvent): void;
  appendEntry(input: SessionEntryInput): SessionEntry;
  /** 从会话管理器重建 Agent 的上下文消息。 */
  reloadMessages(): void;
  activeTool(name: string): ToolDefinition | undefined;
  activeToolNames(): string[];
  runHook(
    event: HookEvent,
    payload: HookEventPayload,
    signal?: AbortSignal,
  ): Promise<HookOutcome | undefined>;
  /** Hook 返回 continue:false 时记下，finishTurn 据此结束 run。 */
  requestStop(reason: string | undefined): void;
  spawnSubagent(request: SubagentRequest): Promise<SubagentResult>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}
