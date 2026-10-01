/**
 * 权限契约（设计 §6.2–§6.3、§7）。[B0] 契约文件，实现归 B3。
 *
 * 补全与偏差：
 * - `ApprovalRequest / ApprovalDecision / ApprovalBroker` 在设计 §6.2 写在 host 契约里，
 *   §1.2 又把 ApprovalRequest 列在本文件。统一定义在这里，host/types.ts 再导出。
 * - 设计只写了 `Rule、Mode、Decision`；补全 `RuleSource`、`PermissionCheckInput`、
 *   `PermissionVerdict`（带决定来自哪一步）与 Runtime 需要的 `PermissionPipelineApi`。
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
  /**
   * 发起方上下文：`depth > 0` 表示来自 `task` 子 Agent（对话框标 `[task]`）；codemode 内层
   * 调用带外层调用的 `parentToolCallId`。由子会话包装的 broker 填入，缺省视为主会话。
   */
  context?: ApprovalRequestContext;
}

export interface ApprovalRequestContext {
  depth: number;
  parentToolCallId?: string;
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
