/**
 * 命令式 Hook 契约（设计 §6.1）。[B0] 契约文件，实现归 B5。
 *
 * 补全与偏差：
 * - 补全 `HookCommand`、`HookMatcherGroup`、`HookConfig`（hooks.json 文件形状）、
 *   `HookRunResult`（单条命令结果）、`HookOutcome`（同一事件全部 Hook 合并后的结论）与
 *   Runtime / AgentSession 需要的 `HookDispatcherApi`。
 * - `HookDecision` = stdout JSON 里 `decision` 的取值；合并规则 deny > block > ask > allow。
 */

import type { PermissionMode } from "../permissions/types.js";

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "Notification"
  | "SessionEnd"
  | "PostRewind"
  /** [W5-C0] 压缩完成后（不可阻止；additionalContext 追加在 ama.post_compact 之后，W5-H1 触发）。 */
  | "PostCompact";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "Notification",
  "SessionEnd",
  "PostRewind",
  "PostCompact",
];

export type HookDecision = "allow" | "deny" | "ask" | "block";

export interface HookCommand {
  type: "command";
  command: string;
  /** 缺省 60 000，上限 600 000。 */
  timeoutMs?: number;
}

export interface HookMatcherGroup {
  /** 缺省匹配全部；只在 Pre/PostToolUse 生效（语法见 §6.1 matcher）。 */
  matcher?: string;
  hooks: HookCommand[];
}

/** hooks.json 文件形状。 */
export interface HookConfig {
  version: 1;
  hooks: Partial<Record<HookEvent, HookMatcherGroup[]>>;
}

export type HookSource = "user" | "profile" | "project" | "sdk";

export interface HookNotification {
  kind: "approval" | "settled" | "error" | "retry";
  message: string;
}

/** stdin 输入：所有事件共有字段 + 事件特有字段。 */
export interface HookInput {
  hookEventName: HookEvent;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  transcriptPath?: string;
  model: { provider: string; id: string };
  permissionMode: PermissionMode;
  depth: number;
  /** 宿主适配器 id（未激活时缺省）。 */
  host?: string;
  /** SessionStart */
  source?: "startup" | "resume" | "new" | "fork";
  /** SessionEnd */
  reason?: "exit" | "new" | "switch";
  // PreToolUse / PostToolUse
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: { content: string; isError: boolean };
  permissionDecision?: "allow" | "ask" | "deny";
  // UserPromptSubmit
  prompt?: string;
  // Stop / SubagentStop
  lastAssistantText?: string;
  /** 已由 Stop Hook 续跑过 → 处理器应避免再 block。 */
  stopHookActive?: boolean;
  // PreCompact / PostCompact
  tokensBefore?: number;
  trigger?: "auto" | "manual";
  /** [W5-C0] PostCompact：压缩后的估算 token。 */
  tokensAfter?: number;
  // Notification
  notification?: HookNotification;
  // PostRewind（[RW-B]，不可阻止）
  /** 回滚到的用户消息条目 id。 */
  entryId?: string;
  mode?: "both" | "conversation" | "code";
  /** 被恢复或删除的文件（cwd 内相对路径，cwd 外绝对路径）；仅对话时为空。 */
  files?: string[];
  /** Pre/PostToolUse：本次调用来自 codemode 脚本里的 `tools.*`（设计 §5.5）。 */
  viaCodemode?: boolean;
  /** Pre/PostToolUse：codemode 内层调用时为外层 `codemode` 调用的 toolCallId。 */
  parentToolCallId?: string;
}

/** stdout JSON 形状；空 / 非 JSON → 无决策。 */
export interface HookOutput {
  decision?: HookDecision;
  reason?: string;
  updatedInput?: unknown;
  updatedPrompt?: string;
  additionalContext?: string;
  customInstructions?: string;
  /** 任何事件：请求结束当前 run。 */
  continue?: false;
  /** TUI 不显示该 Hook 的输出。 */
  suppressOutput?: true;
}

/** 单条 Hook 命令的执行结果。 */
export interface HookRunResult {
  event: HookEvent;
  command: string;
  source: HookSource;
  /** null = 超时或被信号杀死。 */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** stdout 解析成功时存在。 */
  output?: HookOutput;
}

/** 同一事件下全部匹配 Hook 并行结束后的合并结论。 */
export interface HookOutcome {
  /** 最严：deny > block > ask > allow；无决策为 undefined。 */
  decision?: HookDecision;
  /** 决定性 Hook 的 reason，或退出码 2 时的 stderr。 */
  reason?: string;
  /** 只在恰好一个 Hook 返回时采用。 */
  updatedInput?: unknown;
  hasUpdatedInput: boolean;
  updatedPrompt?: string;
  /** 按配置顺序拼接。 */
  additionalContext?: string;
  customInstructions?: string;
  /** 有 Hook 返回 `continue: false`。 */
  stop: boolean;
  suppressOutput: boolean;
  results: HookRunResult[];
  warnings: string[];
}

/** 所有事件共有的公共输入字段；dispatcher 每次运行时现取，调用方可按次覆盖（子 Agent）。 */
export type HookCommonContext = Pick<
  HookInput,
  | "sessionId"
  | "sessionFile"
  | "cwd"
  | "transcriptPath"
  | "model"
  | "permissionMode"
  | "depth"
  | "host"
>;

/**
 * `HookDispatcherApi.run` 第 4 参数：按次覆盖的公共字段。即 `Partial<HookCommonContext>`，
 * 但在 `exactOptionalPropertyTypes` 下也接受显式 `undefined`（视为未给），方便子 Agent 直接传
 * 可能为空的 `sessionFile`。
 */
export type HookContextOverrides = {
  [K in keyof HookCommonContext]?: HookCommonContext[K] | undefined;
};

/** 事件对应的「事件特有」输入（公共字段由 dispatcher 填）。 */
export type HookEventPayload = Omit<
  HookInput,
  | "hookEventName"
  | "sessionId"
  | "sessionFile"
  | "cwd"
  | "transcriptPath"
  | "model"
  | "permissionMode"
  | "depth"
  | "host"
>;

export interface HookDispatcherApi {
  /** 该事件是否有任何已加载的 Hook（无则调用方可跳过构造输入）。 */
  has(event: HookEvent, toolName?: string): boolean;
  /**
   * `context`：按次覆盖公共字段——子 Agent 传自己的 `depth / sessionId / sessionFile`，
   * 未给的字段仍取 dispatcher 的缺省值；值为 `undefined` 的键视为未给。
   */
  run(
    event: HookEvent,
    payload: HookEventPayload,
    signal?: AbortSignal,
    context?: HookContextOverrides,
  ): Promise<HookOutcome>;
  /** doctor / `/hooks` 列表。 */
  list(): readonly { event: HookEvent; matcher?: string; command: string; source: HookSource }[];
}
