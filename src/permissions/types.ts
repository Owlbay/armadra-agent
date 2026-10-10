/**
 * 权限契约（设计 §6.2–§6.3、§7）。[B0] 契约文件，实现归 B3。
 *
 * 补全与偏差：
 * - `ApprovalRequest / ApprovalDecision / ApprovalBroker` 在设计 §6.2 写在 host 契约里，
 *   §1.2 又把 ApprovalRequest 列在本文件。统一定义在这里，host/types.ts 再导出。
 * - 设计只写了 `Rule、Mode、Decision`；补全 `RuleSource`、`PermissionCheckInput`、
 *   `PermissionVerdict`（带决定来自哪一步）与 Runtime 需要的 `PermissionPipelineApi`。
 * - （W3-C0）执行前预览（第三波 §2.2）：`ActionPreview` 定义在这里，`ApprovalRequest.preview`
 *   与 `permission_request` 事件携带；`ApprovalRequestContext.readFiles` 供 write 预览判断
 *   「覆盖未读过的文件」。`previewAction()` 实现归 W3-B9a-2。
 */

import type { ToolPermission } from "../tools/types.js";

/**
 * 六种模式（§7.4）。严格程度从严到宽：plan < allowlist < default < auto-edit < auto < full-auto
 * （项目级只能往左收紧，且不能设 auto / full-auto，§7.2）。
 * `allowlist` 放行只读工具与 allow 规则命中的调用，其余拒绝、从不询问：放行集合是 plan 的超集、
 * default 放行集合的子集，所以排在两者之间。
 */
export type PermissionMode = "plan" | "allowlist" | "default" | "auto-edit" | "auto" | "full-auto";

export const PERMISSION_MODES_STRICT_FIRST: readonly PermissionMode[] = [
  "plan",
  "allowlist",
  "default",
  "auto-edit",
  "auto",
  "full-auto",
];

/** auto 判定发生在哪一层（§7.4）：规则层、静态判定、模型分类器。 */
export type AutoLayer = "rule" | "static" | "classifier";

/** 一次 auto 判定（审计用；线上形状，可 JSON 序列化）。 */
export interface AutoDecision {
  layer: AutoLayer;
  /** 这一层的结论；ask 在无人值守时最终按 deny 执行。 */
  decision: Decision;
  reason: string;
  /** 分类器结果来自会话内缓存。 */
  cached?: boolean;
}

/** `/permissions` 列出的最近判定。 */
export interface AutoAuditEntry extends AutoDecision {
  at: number;
  toolName: string;
  /** 命令或路径摘要（单行、截断）。 */
  summary: string;
}

export type Decision = "allow" | "ask" | "deny";

export type RuleSource = "builtin" | "user" | "profile" | "project" | "cli" | "sdk";

/** `bash(git push*)`、`write(src/**)`、`read(**)`、`canvas_*` 解析结果。 */
export interface Rule {
  effect: "allow" | "deny";
  /** 工具名 glob。 */
  tool: string;
  /** 括号内的 glob：bash 对命令文本，文件工具对路径；缺省匹配全部。 */
  pattern?: string;
  source: RuleSource;
  /** 原始文本，用于诊断。 */
  raw: string;
}

export type ApprovalReason = "mode" | "dangerous" | "hook";

export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  reason: ApprovalReason;
  hookReason?: string;
  /** [W3-C0] 执行前预览（只读、有上限）；预览超时或未实现时缺省。 */
  preview?: ActionPreview;
  /** auto 模式下为什么要询问（规则层或分类器的结论）。 */
  autoDecision?: AutoDecision;
  /**
   * 发起方上下文：`depth > 0` 表示来自 `task` 子 Agent（对话框标 `[task]`）；codemode 内层
   * 调用带外层调用的 `parentToolCallId`。由子会话包装的 broker 填入，缺省视为主会话。
   */
  context?: ApprovalRequestContext;
}

export interface ApprovalRequestContext {
  depth: number;
  parentToolCallId?: string;
  /** [W3-C0] 本会话已 read 过的路径（`ToolContext.readFiles`），由 `gateToolCall` 填入。 */
  readFiles?: ReadonlySet<string>;
  /** [W5-C0] 子 Agent 任务 id（对话框标注 `[task:<agent>]`）。 */
  taskId?: string;
  /**
   * [W5-C0] 来自外部 Agent 的权限请求（docs/history/wave5-plan.md §5.3）：只走 broker 链（宿主 → UI →
   * 无人值守拒绝），auto 分类器与模型都不参与；RPC `permission_request` 原样带出。
   */
  origin?: ExternalPermissionOrigin;
  /** [W6-C0] 触发审批的工具调用 id（`gateToolCall` 填；轨迹据此算 `approvalMs`）。 */
  toolCallId?: string;
}

/** [W5-C0] 外部 Agent 权限选项的种类（ACP 词汇）。 */
export type ExternalPermissionOptionKind =
  "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** [W5-C0] 外部 Agent 发来的权限请求（ACP `session/request_permission` 子集）。 */
export interface ExternalPermissionOrigin {
  /** 外部 Agent id（`claude` / `codex` / `acp:<program>`）。 */
  agent: string;
  /** 外部 CLI 自己的会话 id。 */
  sessionId: string;
  toolCall: { title: string; kind: string; locations?: string[]; inputSummary?: string };
  options: { optionId: string; kind: ExternalPermissionOptionKind }[];
}

/**
 * [W5-EG] `permission_request` 事件的发起方（`ApprovalRequestContext` 的线上子集，可 JSON 序列化）：
 * 只在来自子 Agent / 外部 Agent 时出现。
 */
export interface PermissionRequestContext {
  /** > 0：来自 task 子 Agent（对话框标 `[task:<agent>]`）。 */
  depth?: number;
  taskId?: string;
  /** 外部 Agent 的权限请求（对话框标 `[claude · 会话 abc1]`）。 */
  origin?: ExternalPermissionOrigin;
  /** [W6-C0] 触发审批的工具调用 id（本会话的 toolCallId；外部 Agent 的请求不带）。 */
  toolCallId?: string;
}

/** [W3-C0] 预览涉及的路径（bash 的 rm / mv / 重定向目标，write / edit 的目标文件）。 */
export interface ActionPreviewTarget {
  path: string;
  exists: boolean;
  bytes?: number;
  /** 目录递归计数（上限外不再计）。 */
  files?: number;
}

/** [W3-C0] 审批时「这一步会碰到什么」（第三波 §2.2）。线上形状，可 JSON 序列化。 */
export interface ActionPreview {
  kind: "bash" | "write" | "edit" | "other";
  /** 已排好的人读文本（不含颜色）。 */
  lines: string[];
  severity: "info" | "warn" | "danger";
  affected?: ActionPreviewTarget[];
}

export type ApprovalDecision = "allow" | "deny" | "allow_session";

/** 返回 undefined 表示交给链上下一个回答者（宿主 → UI → 无人值守 deny）。 */
export interface ApprovalBroker {
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | undefined>;
}

export interface PermissionCheckInput {
  toolName: string;
  permission: ToolPermission;
  input: unknown;
  /** 命令式 Hook PreToolUse 合并后的决策（§6.3 第 2 步）；无决策为 undefined。 */
  hookDecision?: Decision;
  hookReason?: string;
  /** 无人值守：ask → deny。 */
  unattended: boolean;
}

/** 管线哪一步做出了最终决定。 */
export type PermissionStep =
  | "deny-rule"
  | "hook-deny"
  | "dangerous"
  | "mode"
  | "allow-rule"
  | "hook"
  | "session"
  /** auto 规则层：受保护路径、网络、删除类、项目外写入。 */
  | "auto-rule"
  /** auto 静态判定放行。 */
  | "auto-static"
  /** auto 留给模型分类器（verdict.classify 为真）。 */
  | "auto-classify"
  /** allowlist 模式下不在允许名单。 */
  | "allowlist";

export interface PermissionVerdict {
  decision: Decision;
  step: PermissionStep;
  /** decision 为 ask 时给 broker 的 reason。 */
  approvalReason?: ApprovalReason;
  rule?: Rule;
  /** 给模型 / 用户看的说明（deny 时写进 tool_result）。 */
  message?: string;
  /** auto 模式的判定记录（layer / reason）；其它模式缺省。 */
  auto?: AutoDecision;
  /**
   * auto 模式下规则层与静态判定都没决定：调用方可以问模型分类器，allow → 放行；否则按本 verdict
   * 的 decision（ask，无人值守时已是 deny）。不认识这个字段的调用方得到的就是保守结论。
   */
  classify?: boolean;
  /**
   * [S2] 这次 bash 调用将经 OS 沙箱运行（docs/guides/sandbox.md「第二阶段」）。default / auto-edit 下因此免审批时
   * 为真；auto 下随 `classify` 一起交给分类器作为输入。
   */
  sandboxed?: boolean;
}

export interface PermissionPipelineApi {
  readonly mode: PermissionMode;
  setMode(mode: PermissionMode): void;
  readonly rules: readonly Rule[];
  check(input: PermissionCheckInput): PermissionVerdict;
  /** allow_session：内存记住 toolName + 归一化输入前缀，不落盘。 */
  rememberForSession(toolName: string, input: unknown): void;
  /** auto 判定审计：记一条（最多保留最近 {@link AUTO_AUDIT_LIMIT} 条）。 */
  recordAutoDecision?(toolName: string, input: unknown, decision: AutoDecision): void;
  /** 最近的 auto 判定，旧的在前。 */
  autoDecisions?(): readonly AutoAuditEntry[];
  /** auto：项目根（分类器输入），缺省 = 会话 cwd。 */
  readonly projectRoot?: string;
}

export const AUTO_AUDIT_LIMIT = 20;
