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
import { msg } from "../../i18n/index.js";
import { parsePermissionMode, permissionModeLabel } from "../../permissions/modes.js";
import type { PermissionMode } from "../../permissions/types.js";
import { planController, type PlanController } from "../../plan/controller.js";
import { executionMode } from "../../plan/store.js";

export function planUsage(): string {
  return msg().plan.usage;
}

export function planStatusText(status: PlanData["status"]): string {
  return msg().plan.status[status];
}

/** 计划的标题：第一个 `#` 标题，没有时取第一行非空文本。 */
export function planTitle(plan: Pick<PlanData, "markdown">): string {
  const lines = plan.markdown.split(/\r?\n/).map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  if (heading !== undefined) return heading.replace(/^#{1,6}\s+/, "");
  return lines.find((l) => l !== "" && !/^<\/?proposed_plan>$/.test(l)) ?? msg().plan.untitled;
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
  const m = msg().plan.command;
  const modeLine =
    mode === "plan"
      ? m.modePlan(permissionModeLabel(executionMode(undefined, pre)))
      : m.mode(permissionModeLabel(mode));
  if (plan === null) {
    return mode === "plan" ? [modeLine, m.noPlanYet].join("\n") : m.noPlan;
  }
  const lines = [
    m.head(plan.version, planStatusText(plan.status), planTitle(plan)),
    ...(plan.filePath !== undefined ? [m.file(plan.filePath)] : []),
    modeLine,
  ];
  if (plan.steps.length > 0) {
    lines.push(m.steps(plan.steps.length));
    for (const step of plan.steps) lines.push(`  ${step.id} ${step.text}`);
  }
  const todos = controller.todos();
  if (todos.length > 0) {
    const done = todos.filter((t) => t.status === "done").length;
    const current = todos.find((t) => t.status === "in_progress");
    lines.push(m.todos(done, todos.length, current?.text));
  }
  if (plan.status === "proposed") lines.push(m.actions);
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
  if (plan === undefined) throw new AmaError("plan_not_found", msg().plan.command.notFound);
  return plan;
}

export async function planCommand(
  session: AgentSession,
  args: string,
  ctx: PlanCommandContext,
): Promise<PlanCommandResult> {
  const controller = planController(session);
  const m = msg().plan.command;
  const [verb = "", ...rest] = args.split(/\s+/).filter((s) => s !== "");
  if (controller === undefined) {
    if (args === "") return { kind: "handled", message: m.unavailable };
    throw new AmaError("invalid_arguments", m.unavailable);
  }
  if (verb === "") return { kind: "handled", message: describePlan(controller, session) };
  if (verb === "approve") {
    if (rest.length > 1) throw new AmaError("invalid_arguments", planUsage());
    const plan = pendingOrLastReply(controller);
    const arg = rest[0];
    if (arg === "fresh") {
      const fresh = await approveFresh(controller, plan, defaultExecutionMode(controller), ctx);
      return { kind: "prompt", text: fresh.prompt };
    }
    const mode = arg === undefined ? defaultExecutionMode(controller) : parsePermissionMode(arg);
    if (mode === undefined || mode === "plan")
      throw new AmaError("invalid_arguments", m.invalidMode(arg ?? "", planUsage()));
    const result = await controller.respond({ planId: plan.id, decision: "approve", mode });
    return {
      kind: "handled",
      message: m.approved(result.plan.version, permissionModeLabel(result.mode ?? mode)),
      wait: true,
    };
  }
  if (verb === "reject" && rest.length === 0) {
    const plan = controller.pending();
    if (plan === undefined) throw new AmaError("plan_not_found", m.notFound);
    await controller.respond({ planId: plan.id, decision: "reject" });
    return { kind: "handled", message: m.rejected(plan.version) };
  }
  // 其余：目标文本
  if (session.state.permissionMode !== "plan") session.setPermissionMode("plan");
  return { kind: "prompt", text: args };
}
