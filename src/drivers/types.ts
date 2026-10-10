/**
 * 外部 Agent 驱动契约（docs/wave5-plan.md §5.1–§5.3，D14）。[W5-C0] 契约文件，实现归 W5-E。
 *
 * 内部词汇 = ACP v1 子集：各家原生协议（Claude stream-json、Codex app-server、一次性打印模式）
 * 都映射成 `DriverEvent`；权限请求以 `DriverPermissionRequest` 交给 ama 的 broker 链——**只交给人，
 * 不代答**（auto 分类器与模型都不参与）。`ProcessRunner`（drivers/runner.ts）把 `AgentDriver`
 * 适配成 `SubagentRunner`，于是外部 Agent 与 ama 子 Agent 共用 `task(agent=…)` 入口。
 *
 * 本目录只依赖 agent / permissions / tools 的类型（零运行时依赖）。
 */

import type { ContentBlock } from "../ai/types.js";
import type { ExternalPermissionOrigin, PermissionMode } from "../permissions/types.js";

export interface DriverCapabilities {
  resume: "resume" | "load" | "none";
  list: boolean;
  /** `unreliable`：有审批通道但不保证每次都走（只在 plan 或只读任务下用）。 */
  permissions: "interactive" | "none" | "unreliable";
  steer: boolean;
  modes: readonly PermissionMode[];
  usage: "tokens" | "usd" | "requests" | "none";
  images: boolean;
}

export type DriverKind =
  "acp" | "acp-adapter" | "claude-stream" | "codex-app-server" | "pi-rpc" | "oneshot" | "host";

export interface DriverProbe {
  installed: boolean;
  version?: string;
  capabilities: DriverCapabilities;
}

export interface DriverOpenOptions {
  cwd: string;
  /** 不得比 ama 当前模式宽（`agents.<id>.maxMode` 显式放宽除外）。 */
  mode: PermissionMode;
  model?: string;
  /** 外部 CLI 自己的会话 id。 */
  resume?: string;
  /** 已按 D16 清理的子进程环境（drivers/env.ts）。 */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /**
   * [W5-E] 美元预算：能透传的驱动透传（Claude `--max-budget-usd`）；其余由 ProcessRunner 按用量
   * 累计、超限 cancel。
   */
  budgetUsd?: number;
  /** [W5-E] 无人值守（没有人能回答审批）：Claude 以 `--permission-prompts none` 启动。 */
  unattended?: boolean;
}

export interface AgentDriver {
  readonly agentId: string;
  readonly kind: DriverKind;
  probe(): Promise<DriverProbe>;
  open(options: DriverOpenOptions): Promise<DriverSession>;
}

/** ACP ToolKind。 */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type DriverEvent =
  | { type: "message_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | {
      type: "tool_call";
      id: string;
      title: string;
      kind: AcpToolKind;
      status: "pending" | "in_progress" | "completed" | "failed";
      locations?: string[];
    }
  | { type: "plan"; entries: { content: string; status: string }[] }
  | {
      type: "usage";
      input?: number;
      output?: number;
      cacheRead?: number;
      costUsd?: number;
      contextTokens?: number;
      contextWindow?: number;
    }
  | { type: "notice"; level: "info" | "warn"; text: string };

/** 外部 Agent 的权限请求 = 审批上下文里的 `origin`（会话 id 与 agent 由驱动填）。 */
export type DriverPermissionRequest = Omit<ExternalPermissionOrigin, "agent" | "sessionId">;

/** 人选了某个选项，或请求被取消（父 abort、`task_ctl stop`、超时、无人值守下的提问类请求）。 */
export type DriverPermissionOutcome =
  { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface DriverTurnResult {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
  finalText: string;
  usage?: { input?: number; output?: number; cacheRead?: number; costUsd?: number };
  filesTouched: string[];
  /** ≤ 20 行。 */
  toolSummary: string[];
}

export interface DriverPromptHooks {
  onEvent(event: DriverEvent): void;
  onPermission(
    request: DriverPermissionRequest,
    signal: AbortSignal,
  ): Promise<DriverPermissionOutcome>;
}

export interface DriverSession {
  /** 一律存 CLI 自己的 id。 */
  readonly sessionId: string;
  prompt(content: ContentBlock[], hooks: DriverPromptHooks): Promise<DriverTurnResult>;
  steer?(content: ContentBlock[]): Promise<void>;
  /** 协议级中断；15 s 无回合结束 → 关 stdin → SIGTERM 进程树。 */
  cancel(): Promise<void>;
  /** 挂起审批统一回 cancelled。 */
  close(): Promise<void>;
}
