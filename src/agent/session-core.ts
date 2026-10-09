/**
 * AgentSessionImpl 的装配选项与内部协作接口。[B2]
 *
 * `AgentSessionOptions` 是集成者（B5 bootstrap / B6 sdk）构造会话时注入的全部依赖；
 * `SessionCore` 是 session.ts 交给 session-tools.ts / session-compaction.ts 的内部视图（避免循环 import）。
 */

import type { WarmingDecisionHandler } from "../ai/cache/types.js";
import type { CheckpointHooks } from "../checkpoints/types.js";
import type { Model, ModelThinkingLevel, ProviderRegistryApi } from "../ai/types.js";
import type {
  HookDispatcherApi,
  HookEvent,
  HookEventPayload,
  HookOutcome,
} from "../hooks/types.js";
import type { PermissionClassifier } from "../permissions/classifier.js";
import type { ApprovalBroker, PermissionPipelineApi } from "../permissions/types.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionEntry, SessionEntryInput } from "../session/types.js";
import type { SubagentRequest, SubagentResult, ToolDefinition } from "../tools/types.js";
import type { Agent } from "./agent.js";
import type { StreamFn } from "./loop.js";
import type { SessionCacheController } from "./session-cache.js";
import type { CheckpointBackendFactory } from "../checkpoints/index.js";
import type { SessionExtensionFactory } from "./session-extensions.js";
import type { SystemPromptInput } from "./system-prompt.js";
import type {
  CacheSettings,
  CompactionSettings,
  QueueMode,
  RetrySettings,
  SessionEvent,
  SessionLimits,
} from "./types.js";

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
  /** [ME-C0] 留在请求工具表里、执行时拒绝的工具（fork 子会话的 tools / disallowed-tools）。 */
  unavailableTools?: readonly string[];
  /** 权限管线（B3）；缺省 = 全部放行。 */
  permission?: PermissionPipelineApi;
  /** 审批回答者链：宿主 broker → UI broker；都返回 undefined → deny（无人值守）。 */
  brokers?: readonly ApprovalBroker[];
  /** 无人值守：权限管线把 ask 变 deny。 */
  unattended?: boolean;
  /**
   * auto 权限模式的模型分类器（§7.4）：`model` 为 `provider/model`（config `permission.autoModel`），
   * 缺省用当前会话模型；`timeoutMs` 缺省 10 000。
   */
  permissionClassifier?: { model?: string; timeoutMs?: number };
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
  /** 模型请求的空闲超时（毫秒，0 关闭）；缺省由协议层取 300 000。 */
  idleTimeoutMs?: number;
  /** 子 Agent 的回合上限（maxTurns）。 */
  maxTurns?: number;
  /**
   * [W5-C0] 会话预算（`--max-turns` / `--max-cost` / config `limits.*`）；到限发 `limit_reached`
   * 并结束 run（实现归 W5-H2 的 limits 扩展，C0 只透传）。
   */
  limits?: SessionLimits;
  /**
   * [W5-C0] 会话扩展的工厂（session-extensions.ts）：每个会话实例（含 fork 与 task 子会话）各调一次；
   * 组装根从 `cli/compose-extensions.ts` 的表取得。缺省无扩展。
   */
  extensions?: readonly SessionExtensionFactory[];
  /** [W5-C0] 回退模型 `provider/model[@channel]`（config `fallbackModel`，实现归 W5-H2）。 */
  fallbackModel?: string;
  /** 子 Agent 并发上限，缺省 4；`false` 关闭 spawnSubagent。 */
  subagents?: { maxConcurrent?: number } | false;
  /** 宿主适配器 id（写进 HookInput.host）。 */
  hostId?: string;
  /** [W3-C1b] 会话层缓存设置（config `cache` 段 + 环境变量，组装根解析）；缺省见 DEFAULT_CACHE_SETTINGS。 */
  cache?: Partial<CacheSettings>;
  /** [W3-C1b] 宿主 `cache.onWarmingDecision` 的处理器（每次保温前现取）。 */
  warmingDecider?(): WarmingDecisionHandler | undefined;
  /**
   * [RW-B] 检查点后端工厂（rewind-plan §2）：只在主会话（depth 0）且会话有目录时调用；返回
   * undefined = 不建检查点（`checkpoints.mode: "off"`）。
   */
  checkpoints?: CheckpointBackendFactory;
  /** [RW-B] task 子会话：父会话的检查点钩子（编辑记到父会话当前回合）。 */
  checkpointHooks?: CheckpointHooks;
  /** [RW-B] 中断即撤回（config `ui.restoreOnCancel`，缺省 true）。 */
  restoreOnCancel?: boolean;
  log?(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface SessionCore {
  readonly options: AgentSessionOptions;
  readonly manager: SessionManager;
  readonly agent: Agent;
  readonly cwd: string;
  readonly depth: number;
  readonly readFiles: Set<string>;
  /** [W3-C1b] 会话层缓存控制器（摘要续写取前缀）。 */
  readonly cache?: SessionCacheController;
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
  /** 任一已登记工具（不限于活动集；嵌套调用用）。 */
  tool(name: string): ToolDefinition | undefined;
  activeToolNames(): string[];
  /** 当前的系统提示静态部分（`updateSystem` 之后的；统计启动基线用）。缺省时用 `options.system`。 */
  childBase?(): Pick<AgentSessionOptions, "system">;
  runHook(
    event: HookEvent,
    payload: HookEventPayload,
    signal?: AbortSignal,
  ): Promise<HookOutcome | undefined>;
  /** Hook 返回 continue:false 时记下，finishTurn 据此结束 run。 */
  requestStop(reason: string | undefined): void;
  spawnSubagent(request: SubagentRequest): Promise<SubagentResult>;
  /** [RW-B] ToolContext.checkpoint：本会话的检查点钩子（无则 undefined）。 */
  checkpointHooks?(): CheckpointHooks | undefined;
  /** auto 权限模式的分类器（懒建，会话内缓存判定）。 */
  autoClassifier(): PermissionClassifier;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}
