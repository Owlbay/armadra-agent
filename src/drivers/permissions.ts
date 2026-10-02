/**
 * 外部 Agent 的权限：交人、不代答（docs/wave5-plan.md §5.3，D15）。[W5-E]
 *
 * 1. 子 Agent 自己的策略先判，它决定要问人的才到 ama；到了以后只走审批通道（宿主 → UI →
 *    无人值守拒绝），auto 分类器与模型都不参与——`approve` 由调用方接到会话的
 *    `requestApproval`（发 permission_request 事件、走 broker 链），而不是 `gateToolCall`。
 * 2. 选项映射：允许 → 首个 allow_once；本会话允许 → allow_always（由子 Agent 自己记，ama 不缓存）；
 *    拒绝 → reject_once。reject_always（会改子 CLI 的持久配置）不由这里选。
 * 3. 无人值守：reject_once（没有则 cancelled），不询问。
 * 4. 父 abort / stop / 超时：cancelled。
 * 5. 模式：外部 Agent 的模式不得比 ama 当前模式宽；`agents.<id>.maxMode`（只认用户级）显式放宽。
 */

import { randomUUID } from "node:crypto";
import { PERMISSION_MODES_STRICT_FIRST } from "../permissions/types.js";
import type { ApprovalDecision, ApprovalRequest, PermissionMode } from "../permissions/types.js";
import type { DriverPermissionOutcome, DriverPermissionRequest } from "./types.js";

export type ApproveFn = (
  request: ApprovalRequest,
  signal: AbortSignal,
) => Promise<ApprovalDecision>;

export interface AskHumanContext {
  agent: string;
  sessionId: string;
  unattended: boolean;
  approve: ApproveFn;
  signal: AbortSignal;
}

/** 审批对话框里显示的工具名：`agent:<id>`（RPC permission_request 的 toolName）。 */
export function externalToolName(agent: string): string {
  return `agent:${agent}`;
}

function pick(
  request: DriverPermissionRequest,
  kind: DriverPermissionRequest["options"][number]["kind"],
): DriverPermissionOutcome | undefined {
  const option = request.options.find((o) => o.kind === kind);
  return option === undefined ? undefined : { outcome: "selected", optionId: option.optionId };
}

const CANCELLED: DriverPermissionOutcome = { outcome: "cancelled" };

/** ApprovalDecision → 外部 Agent 的选项。 */
export function outcomeFor(
  request: DriverPermissionRequest,
  decision: ApprovalDecision,
): DriverPermissionOutcome {
  switch (decision) {
    case "allow":
      return pick(request, "allow_once") ?? CANCELLED;
    case "allow_session":
      return pick(request, "allow_always") ?? pick(request, "allow_once") ?? CANCELLED;
    case "deny":
      return pick(request, "reject_once") ?? CANCELLED;
  }
}

/** 把外部 Agent 的权限请求交给人。 */
export async function askHuman(
  request: DriverPermissionRequest,
  ctx: AskHumanContext,
): Promise<DriverPermissionOutcome> {
  if (ctx.signal.aborted) return CANCELLED;
  if (ctx.unattended) return pick(request, "reject_once") ?? CANCELLED;
  const approval: ApprovalRequest = {
    requestId: randomUUID(),
    toolName: externalToolName(ctx.agent),
    input: request.toolCall,
    reason: "mode",
    context: {
      depth: 1,
      origin: {
        agent: ctx.agent,
        sessionId: ctx.sessionId,
        toolCall: request.toolCall,
        options: request.options,
      },
    },
  };
  let decision: ApprovalDecision;
  try {
    decision = await ctx.approve(approval, ctx.signal);
  } catch {
    return CANCELLED;
  }
  if (ctx.signal.aborted) return CANCELLED;
  return outcomeFor(request, decision);
}

function rank(mode: PermissionMode): number {
  return PERMISSION_MODES_STRICT_FIRST.indexOf(mode);
}

/** 两个模式里更严的那个。 */
export function stricterMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return rank(a) <= rank(b) ? a : b;
}

/**
 * 外部 Agent 实际使用的模式：请求的模式夹到上限之内；上限 = `maxMode`（用户显式配置）或父会话
 * 当前模式。
 */
export function clampMode(
  requested: PermissionMode,
  parent: PermissionMode | undefined,
  maxMode: PermissionMode | undefined,
): PermissionMode {
  const bound = maxMode ?? parent;
  return bound === undefined ? requested : stricterMode(requested, bound);
}

/** 驱动支持的模式里，不宽于 `mode` 的最宽的一个；没有返回 undefined。 */
export function supportedMode(
  mode: PermissionMode,
  supported: readonly PermissionMode[],
): PermissionMode | undefined {
  let best: PermissionMode | undefined;
  for (const m of supported)
    if (rank(m) <= rank(mode) && (best === undefined || rank(m) > rank(best))) best = m;
  return best;
}
