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

/** 严格程度：plan > default > auto-edit > full-auto（项目级只能往左收紧，§7.2）。 */
export type PermissionMode = "plan" | "default" | "auto-edit" | "full-auto";

export const PERMISSION_MODES_STRICT_FIRST: readonly PermissionMode[] = [
  "plan",
  "default",
  "auto-edit",
  "full-auto",
];

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
  "deny-rule" | "hook-deny" | "dangerous" | "mode" | "allow-rule" | "hook" | "session";

export interface PermissionVerdict {
  decision: Decision;
  step: PermissionStep;
  /** decision 为 ask 时给 broker 的 reason。 */
  approvalReason?: ApprovalReason;
  rule?: Rule;
  /** 给模型 / 用户看的说明（deny 时写进 tool_result）。 */
  message?: string;
}

export interface PermissionPipelineApi {
  readonly mode: PermissionMode;
  setMode(mode: PermissionMode): void;
  readonly rules: readonly Rule[];
  check(input: PermissionCheckInput): PermissionVerdict;
  /** allow_session：内存记住 toolName + 归一化输入前缀，不落盘。 */
  rememberForSession(toolName: string, input: unknown): void;
}
