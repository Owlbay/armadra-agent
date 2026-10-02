/**
 * `/plan` 的语义（line 模式与交互模式共用，经 commands-core）。[W5-U]
 *
 * - `/plan`：当前计划与状态（版本、状态、文件、步骤、待办进度、所处模式）；
 * - `/plan approve [模式|fresh]`：批准待审批的计划（没有计划块时把上一条回复当作计划，docs/wave5-plan.md
 *   §6.3）；模式缺省回到进入 plan 前的模式，`fresh` 在新会话里执行（新建会话 → `adopt(plan)` → 发计划
 *   全文）；
 * - `/plan reject`：放弃待审批的计划（留在 Plan 模式）；
 * - `/plan <目标>`：进入 Plan 模式并把目标作为提示发出。
 */

import type { AgentSession, PlanData } from "../../agent/types.js";
import type { SwitchRequest } from "../../cli/compose-session.js";
import { AmaError } from "../../errors.js";
import { parsePermissionMode, permissionModeLabel } from "../../permissions/modes.js";
import type { PermissionMode } from "../../permissions/types.js";
import { planController, type PlanController } from "../../plan/controller.js";
import { executionMode } from "../../plan/store.js";

export const PLAN_USAGE = "用法：/plan [目标] | /plan approve [模式|fresh] | /plan reject";

const STATUS_TEXT: Readonly<Record<PlanData["status"], string>> = {
  proposed: "待审批",
  approved: "已批准",
  rejected: "已放弃",
  superseded: "已被新版本取代",
};

export function planStatusText(status: PlanData["status"]): string {
  return STATUS_TEXT[status];
}

/** 计划的标题：第一个 `#` 标题，没有时取第一行非空文本。 */
export function planTitle(plan: Pick<PlanData, "markdown">): string {
  const lines = plan.markdown.split(/\r?\n/).map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  if (heading !== undefined) return heading.replace(/^#{1,6}\s+/, "");
  return lines.find((l) => l !== "" && !/^<\/?proposed_plan>$/.test(l)) ?? "（无标题）";
}

/** 批准后的执行模式（缺省回到进入 plan 前的模式；进入前就是 plan 则 default）。 */
export function defaultExecutionMode(controller: PlanController): PermissionMode {
  return executionMode(undefined, controller.prePlanMode());
}

/** `/plan` 的纯文本说明。 */
export function describePlan(controller: PlanController, session: AgentSession): string {
  const plan = controller.current();
  const mode = session.state.permissionMode;
  const pre = controller.prePlanMode();
  const modeLine =
    mode === "plan"
      ? `模式：Plan（批准后回到 ${permissionModeLabel(executionMode(undefined, pre))}）`
      : `模式：${permissionModeLabel(mode)}`;
  if (plan === null) {
    return mode === "plan"
      ? [modeLine, "还没有计划：模型给出 <proposed_plan> 后在这里审批"].join("\n")
      : "没有计划。/plan <目标> 进入 Plan 模式";
  }
  const lines = [
    `计划 v${plan.version} · ${planStatusText(plan.status)} · ${planTitle(plan)}`,
    ...(plan.filePath !== undefined ? [`文件：${plan.filePath}`] : []),
    modeLine,
  ];
  if (plan.steps.length > 0) {
    lines.push(`步骤（${plan.steps.length}）：`);
    for (const step of plan.steps) lines.push(`  ${step.id} ${step.text}`);
  }
  const todos = controller.todos();
  if (todos.length > 0) {
    const done = todos.filter((t) => t.status === "done").length;
    const current = todos.find((t) => t.status === "in_progress");
    lines.push(
      `待办：${done}/${todos.length} 完成${current !== undefined ? ` · 进行中 ${current.text}` : ""}`,
    );
  }
  if (plan.status === "proposed")
    lines.push("/plan approve [模式|fresh] 批准 · /plan reject 放弃 · 直接输入修改意见");
  return lines.join("\n");
}

export interface PlanCommandContext {
  switchSession(request: SwitchRequest): Promise<AgentSession>;
}

export type PlanCommandResult =
  { kind: "handled"; message: string; wait?: boolean } | { kind: "prompt"; text: string };

/** 「新上下文执行」：新建会话、记下计划与 todo、切到执行模式，返回首条消息。 */
export async function approveFresh(
  controller: PlanController,
  plan: PlanData,
  mode: PermissionMode,
  ctx: PlanCommandContext,
  editedMarkdown?: string,
): Promise<{ session: AgentSession; prompt: string; plan: PlanData }> {
  const result = await controller.respond({
    planId: plan.id,
    decision: "approve_fresh",
    mode,
    ...(editedMarkdown !== undefined ? { editedMarkdown } : {}),
  });
  const next = await ctx.switchSession({ kind: "new" });
  planController(next)?.adopt(result.plan);
  next.setPermissionMode(result.mode ?? mode);
  return { session: next, prompt: result.freshPrompt ?? result.plan.markdown, plan: result.plan };
}

function pendingOrLastReply(controller: PlanController): PlanData {
  const plan = controller.pending() ?? controller.proposeFromLastReply();
  if (plan === undefined) throw new AmaError("plan_not_found", "没有待审批的计划");
  return plan;
}

export async function planCommand(
  session: AgentSession,
  args: string,
  ctx: PlanCommandContext,
): Promise<PlanCommandResult> {
  const controller = planController(session);
  const [verb = "", ...rest] = args.split(/\s+/).filter((s) => s !== "");
  if (controller === undefined) {
    if (args === "") return { kind: "handled", message: "当前会话没有 Plan 能力" };
    throw new AmaError("invalid_arguments", "当前会话没有 Plan 能力");
  }
  if (verb === "") return { kind: "handled", message: describePlan(controller, session) };
  if (verb === "approve") {
    if (rest.length > 1) throw new AmaError("invalid_arguments", PLAN_USAGE);
    const plan = pendingOrLastReply(controller);
    const arg = rest[0];
    if (arg === "fresh") {
      const fresh = await approveFresh(controller, plan, defaultExecutionMode(controller), ctx);
      return { kind: "prompt", text: fresh.prompt };
    }
    const mode = arg === undefined ? defaultExecutionMode(controller) : parsePermissionMode(arg);
    if (mode === undefined || mode === "plan")
      throw new AmaError("invalid_arguments", `执行模式无效：${arg ?? ""}（${PLAN_USAGE}）`);
    const result = await controller.respond({ planId: plan.id, decision: "approve", mode });
    return {
      kind: "handled",
      message: `已批准计划 v${result.plan.version}，以 ${permissionModeLabel(result.mode ?? mode)} 执行`,
      wait: true,
    };
  }
  if (verb === "reject" && rest.length === 0) {
    const plan = controller.pending();
    if (plan === undefined) throw new AmaError("plan_not_found", "没有待审批的计划");
    await controller.respond({ planId: plan.id, decision: "reject" });
    return { kind: "handled", message: `已放弃计划 v${plan.version}（仍在 Plan 模式）` };
  }
  // 其余：目标文本
  if (session.state.permissionMode !== "plan") session.setPermissionMode("plan");
  return { kind: "prompt", text: args };
}
