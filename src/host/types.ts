/**
 * 宿主适配器契约（设计 §6.2，`@armadra/agent/host`）。[B0] 契约文件，实现归 B5。
 *
 * 补全与偏差：
 * - `InstructionSource` 设计未展开，按 v1 §8.5 补全为 file / text 两种。
 * - `ApprovalBroker / ApprovalRequest / ApprovalDecision` 定义在 permissions/types.ts，此处再导出。
 * - `HostMode` 抽成具名类型；`AgentEvents` 中空载荷用 `Record<string, never>` 表示
 *   （设计写 `{}`，在 strict 下 `{}` 意为「任意非空值」，语义不对）。
 * - `HostAdapterHandle` 是 Runtime 持有的已激活适配器（loader.ts 产出）。
 */

import type { HookEvent } from "../hooks/types.js";
import type { ApprovalBroker, ApprovalDecision } from "../permissions/types.js";
import type { ToolDefinition } from "../tools/types.js";

export type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalReason,
  ApprovalRequest,
} from "../permissions/types.js";
export type {
  ToolAnnotations,
  ToolContext,
  ToolDefinition,
  ToolExecutionMode,
  ToolPermission,
  ToolResult,
} from "../tools/types.js";
export type { JsonSchema } from "../ai/types.js";

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
}

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
