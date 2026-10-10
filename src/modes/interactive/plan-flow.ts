/**
 * 交互界面的计划审批编排（docs/history/wave5-plan.md §6.1）：把会话的计划审批交给对话框。[W5-U]
 *
 * - `attach(session)`：`planController(session).setAttendance("callback", …)`——计划提出后（会话空闲时）
 *   打开审批框；同时关掉 W5-F 的文本回复审批与 `ama.plan_notice` 提示行（两者只在 `text` 时生效）。
 *   resume 回来已有待审批的计划时只提示一行（`/plan` 打开审批框）。
 * - 选择 → `controller.respond()`：批准（指定执行模式，编辑过则带 `editedMarkdown`）、继续修改（意见作为
 *   普通用户消息）、放弃（4 退出 Plan 模式；Esc 留在 Plan）；「新上下文执行」先新建会话、`adopt(plan)`、
 *   切执行模式，再发 `freshPrompt`。
 */

import type { AgentSession, PlanData } from "../../agent/types.js";
import type { SwitchRequest } from "../../cli/compose-session.js";
import { msg } from "../../i18n/index.js";
import { permissionModeLabel } from "../../permissions/modes.js";
import { planController } from "../../plan/controller.js";
import { executionMode } from "../../plan/store.js";
import type { NoticeLevel } from "./message-view.js";
import { approveFresh } from "./plan-command.js";
import { openPlanDialog, type PlanChoice, type PlanDialogHost } from "./plan-dialog.js";

export interface PlanFlowDeps {
  dialog: PlanDialogHost;
  switchSession(request: SwitchRequest): Promise<AgentSession>;
  notice(level: NoticeLevel, text: string): void;
  /** 在当前会话发一条提示（新上下文执行的首条消息）。 */
  prompt(text: string): void;
  /** 测试注入：代替真实对话框。 */
  open?(dialog: PlanDialogHost, input: Parameters<typeof openPlanDialog>[1]): Promise<PlanChoice>;
}

export class PlanFlow {
  private opened: string | undefined;

  constructor(private readonly deps: PlanFlowDeps) {}

  /** 接管会话的计划审批（每次切换会话后调用）。 */
  attach(session: AgentSession): void {
    const controller = planController(session);
    if (controller === undefined) return;
    controller.setAttendance("callback", async (plan) => {
      await this.ask(session, plan);
      return undefined;
    });
    const pending = controller.pending();
    if (pending !== undefined) this.deps.notice("info", msg().plan.flow.pending(pending.version));
  }

  get isOpen(): boolean {
    return this.opened !== undefined;
  }

  /** 打开审批框并执行选择（同一计划同时只开一个）。 */
  async ask(session: AgentSession, plan: PlanData): Promise<void> {
    const controller = planController(session);
    if (controller === undefined || this.opened !== undefined) return;
    this.opened = plan.id;
    try {
      const input = { plan, preMode: executionMode(undefined, controller.prePlanMode()) };
      const choice = await (this.deps.open ?? openPlanDialog)(this.deps.dialog, input);
      await this.apply(session, plan, choice);
    } catch (error) {
      this.deps.notice("error", error instanceof Error ? error.message : String(error));
    } finally {
      this.opened = undefined;
    }
  }

  private async apply(session: AgentSession, plan: PlanData, choice: PlanChoice): Promise<void> {
    const controller = planController(session);
    if (controller === undefined) return;
    switch (choice.decision) {
      case "approve": {
        const result = await controller.respond({
          planId: plan.id,
          decision: "approve",
          mode: choice.mode,
          ...(choice.editedMarkdown !== undefined ? { editedMarkdown: choice.editedMarkdown } : {}),
        });
        const mode = permissionModeLabel(result.mode ?? choice.mode);
        this.deps.notice("info", msg().plan.flow.approved(result.plan.version, mode));
        return;
      }
      case "approve_fresh": {
        const fresh = await approveFresh(
          controller,
          plan,
          choice.mode,
          { switchSession: (request) => this.deps.switchSession(request) },
          choice.editedMarkdown,
        );
        this.deps.notice(
          "info",
          msg().plan.flow.approvedFresh(
            fresh.plan.version,
            fresh.session.state.sessionId.slice(0, 8),
            permissionModeLabel(choice.mode),
          ),
        );
        this.deps.prompt(fresh.prompt);
        return;
      }
      case "revise":
        await controller.respond({
          planId: plan.id,
          decision: "revise",
          feedback: choice.feedback,
        });
        return;
      case "reject": {
        const pre = executionMode(undefined, controller.prePlanMode());
        await controller.respond({ planId: plan.id, decision: "reject" });
        if (choice.exit) {
          session.setPermissionMode(pre);
          this.deps.notice(
            "info",
            msg().plan.flow.rejectedExit(plan.version, permissionModeLabel(pre)),
          );
        } else this.deps.notice("info", msg().plan.flow.rejectedStay(plan.version));
        return;
      }
    }
  }
}
