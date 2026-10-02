/**
 * 宿主适配器契约（设计 §6.2，`@armadra/agent/host`）。[B0] 契约文件，实现归 B5。
 *
 * 补全与偏差：
 * - `InstructionSource` 设计未展开，按 v1 §8.5 补全为 file / text 两种。
 * - `ApprovalBroker / ApprovalRequest / ApprovalDecision` 定义在 permissions/types.ts，此处再导出。
 * - `HostMode` 抽成具名类型；`AgentEvents` 中空载荷用 `Record<string, never>` 表示
 *   （设计写 `{}`，在 strict 下 `{}` 意为「任意非空值」，语义不对）。
 * - `HostAdapterHandle` 是 Runtime 持有的已激活适配器（loader.ts 产出）。
 * - （W3-C0）第三波 §1.10 / §1.7：`AgentEvents` 加 `cache_miss`、`context_pressure`；
 *   `HostApi.cache.onWarmingDecision` 为可选面（HOST_API_VERSION 不变，旧宿主不受影响），
 *   多个处理器时最后注册的生效。
 * - （W5-C0）第五波 §5.5 / §6.5 / §7.5：可选面 `HostApi.runners`（宿主注入的子 Agent runner，
 *   以 `task(agent=…)` 入口出现；有宿主时内置外部 runner 一律不可用，实现归 W5-E / W5-G）；
 *   `AgentEvents` 加 `subagent_start / subagent_end / plan_proposed / plan_resolved`。
 *   HOST_API_VERSION 不变。
 */

import type { CacheMiss, WarmingDecisionHandler } from "../ai/cache/types.js";
import type { HookEvent } from "../hooks/types.js";
import type { ApprovalBroker, ApprovalDecision } from "../permissions/types.js";
import type { SubagentRunner, ToolDefinition } from "../tools/types.js";
import type {
  PlanProposedEvent,
  PlanResolvedEvent,
  SubagentEndEvent,
  SubagentStartEvent,
} from "../agent/types-w5.js";

export type {
  ActionPreview,
  ActionPreviewTarget,
  ApprovalBroker,
  ApprovalDecision,
  ApprovalReason,
  ApprovalRequest,
  ApprovalRequestContext,
} from "../permissions/types.js";
export type {
  RunnerHandle,
  SubagentEvent,
  SubagentRunRequest,
  SubagentRunner,
  ToolAnnotations,
  ToolContext,
  ToolDefinition,
  ToolExecutionMode,
  ToolPermission,
  ToolResult,
} from "../tools/types.js";
export type { JsonSchema } from "../ai/types.js";
export type { CacheMiss, WarmDecision, WarmingDecisionHandler } from "../ai/cache/types.js";

export const HOST_API_VERSION = 1 as const;
export type HostApiVersion = typeof HOST_API_VERSION;

export type HostMode = "interactive" | "line" | "print" | "rpc";

export type InstructionSource =
  { kind: "file"; path: string } | { kind: "text"; text: string; name?: string };

export interface HostModule {
  readonly hostApi: HostApiVersion;
  create(api: HostApi): HostAdapter | undefined | Promise<HostAdapter | undefined>;
}

export interface HostAdapter {
  readonly id: string;
  /** session_shutdown 后调用，幂等。 */
  dispose?(): void | Promise<void>;
}

type Empty = Record<string, never>;

export interface AgentEvents {
  session_start: {
    sessionId: string;
    sessionFile?: string;
    cwd: string;
    reason: "startup" | "resume" | "new" | "fork";
  };
  before_agent_start: { prompt: string };
  agent_start: Empty;
  turn_start: Empty;
  turn_end: Empty;
  tool_call: { toolCallId: string; toolName: string; input: unknown };
  tool_result: { toolCallId: string; toolName: string; isError: boolean };
  agent_end: { stopReason: string; willRetry: boolean };
  agent_before_settle: Empty;
  agent_settled: { warning?: string };
  session_compact: { tokensBefore: number };
  model_select: { model: { id: string; provider: string } };
  tool_approval_requested: { requestId: string; toolName: string };
  tool_approval_resolved: { requestId: string; decision: ApprovalDecision };
  hook_executed: { event: HookEvent; command: string; exitCode: number | null; durationMs: number };
  session_shutdown: Empty;
  /** [W3-C0] 一次缓存未命中（重计费 token / 金额与原因）。 */
  cache_miss: CacheMiss;
  /** [W3-C0] 上下文占用跨越 70% / 90%。 */
  context_pressure: {
    percent: number;
    threshold: 70 | 90;
    remainingTokens?: number;
    estimatedTurnsLeft?: number;
  };
  /** [W5-C0] 子 Agent 任务开始 / 结束（含宿主 runner 与外部 Agent）。 */
  subagent_start: Omit<SubagentStartEvent, "type">;
  subagent_end: Omit<SubagentEndEvent, "type">;
  /** [W5-C0] 计划提出 / 审批结果。 */
  plan_proposed: Omit<PlanProposedEvent, "type">;
  plan_resolved: Omit<PlanResolvedEvent, "type">;
}

/** [W5-C0] 宿主注入的 runner：`id` 即 `task(agent=<id>)` 的名字，`description` 进 task 工具描述。 */
export type HostRunner = SubagentRunner & { readonly description: string };

export type AgentEventName = keyof AgentEvents;

export interface HostApi {
  readonly version: HostApiVersion;
  readonly agent: { readonly name: "ama"; readonly version: string };
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly mode: HostMode;
  readonly session: {
    id(): string;
    file(): string | undefined;
    cwd(): string;
    model(): { provider: string; id: string } | undefined;
  };
  readonly tools: {
    /** 同名已存在则抛错。 */
    register(tool: ToolDefinition): void;
    /** 隐藏内置工具（如 task）。 */
    disable(name: string): void;
    list(): readonly string[];
  };
  /** 追加到系统提示 `host` 节（最后）。 */
  readonly instructions: { add(source: InstructionSource): void };
  readonly events: {
    on<E extends AgentEventName>(
      name: E,
      handler: (event: AgentEvents[E]) => void | Promise<void>,
    ): () => void;
  };
  readonly approvals: { setBroker(broker: ApprovalBroker): void };
  /** 以 user 消息注入（运行中按 steer 入队），origin 缺省 "host"。 */
  readonly messages: { sendUser(text: string, origin?: string): Promise<"started" | "queued"> };
  /** print / rpc 下 notify → stderr / 事件。 */
  readonly ui: {
    notify(message: string, level?: "info" | "warn" | "error"): void;
    setStatus(key: string, text?: string): void;
  };
  readonly log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    detail?: unknown,
  ) => void;
  /**
   * [W3-C0] 缓存保温的否决钩子（第三波 §1.7）：每次保温前以内置决策调用，返回 `"stop"` 即不发；
   * 处理器出错回落内置决策。返回值用于注销。可选面：旧版本运行时没有它。
   */
  readonly cache?: {
    onWarmingDecision(handler: WarmingDecisionHandler): () => void;
  };
  /**
   * [W5-C0] 宿主注入的子 Agent runner（画布节点等，docs/wave5-plan.md §5.5）：注入后同名的内置
   * 外部 runner 被替换；返回值用于注销。可选面：旧版本运行时没有它（实现归 W5-E / W5-G）。
   */
  readonly runners?: {
    provide(runner: HostRunner): () => void;
  };
}

/** Runtime 持有的已激活适配器。 */
export interface HostAdapterHandle {
  readonly adapter: HostAdapter;
  readonly api: HostApi;
  /** 模块来源（路径或 "sdk"）。 */
  readonly source: string;
  /** 宿主 setStatus 的当前值（状态栏显示）。 */
  status(): ReadonlyMap<string, string>;
}
