/**
 * Plan 扩展：模式说明注入、`plan_state` 持久化、计划提取与审批编排、交接（docs/wave5-plan.md §6、
 * D18–D21）。[W5-F] 只装在根会话（task 子会话的计划块作为 task 结果返回给父会话）。
 *
 * - 进入 plan（任何来源的 `permission_mode_changed`，或会话以 plan 启动 / resume 回到 plan）：记
 *   prePlanMode，落 `custom{ama.plan_state{active:true}}`；之后的提示前按节奏追加
 *   `custom_message{ama.plan_mode}`（第 1 个提示完整版，之后每 5 个提示一次简版，每第 5 次完整版；
 *   压缩后的首个提示补完整版）。手动退出：下一个提示前追加 `ama.plan_mode_exit`。全部只追加在尾部，
 *   不改 system 与工具表（§9.1）。
 * - 提取：plan 下一回合以纯文本结束（无工具调用）时，从这条回复里取 `<proposed_plan>`，落
 *   `custom{ama.plan{status:"proposed"}}` 与计划文件，发 `plan_proposed`。
 * - 审批（谁来答，见 {@link PlanAttendance}）：客户端 / SDK 回调 / 交互模式文本回复；无人值守按
 *   `plan.unattended`（缺省 stop：落盘后停下，**不替人批准**；approve 才自动批准）。
 * - 批准：落 approved、步骤转 `ama.todo`（首项 in_progress）、切回执行模式（缺省进入前的模式）、
 *   `plan.model` 配置时切回执行模型，然后以 `custom_message{ama.plan_approved}`（计划全文 + 文件路径
 *   + 按 todo 推进）开启新回合。「新上下文执行」由调用方新建会话，用 `adopt()` + `freshPrompt`。
 */

import { randomUUID } from "node:crypto";
import { formatModelRef } from "../ai/providers/channels.js";
import type { ModelThinkingLevel } from "../ai/types.js";
import { AmaError } from "../errors.js";
import { permissionModeLabel } from "../permissions/modes.js";
import type { PermissionMode, PermissionPipelineApi } from "../permissions/types.js";
import { extractProposedPlan, planFromMarkdown, type ExtractedPlan } from "../plan/extract.js";
import {
  PLAN_APPROVED_PROMPT,
  PLAN_APPROVED_TYPE,
  PLAN_MODE_BRIEF,
  PLAN_MODE_EXIT,
  PLAN_MODE_EXIT_TYPE,
  PLAN_MODE_FULL,
  PLAN_MODE_TYPE,
  freshContextPrompt,
  planApprovedText,
  planMessage,
  reminderKind,
} from "../plan/prompts.js";
import {
  PLAN_CUSTOM_TYPE,
  PLAN_STATE_CUSTOM_TYPE,
  currentTodos,
  executionMode,
  latestPlan,
  latestPlanState,
  maxPlanVersion,
  resolvePlanDirectory,
  writePlanFile,
  type PlanStateRecord,
} from "../plan/store.js";
import {
  APPROVE_REPLY,
  PLAN_NOTICE_TYPE,
  registerPlanController,
  type PlanAttendance,
  type PlanController,
  type PlanDecisionHandler,
  type PlanExtensionOptions,
  type PlanResponse,
  type PlanResponseResult,
} from "../plan/controller.js";
import type { AgentMessage } from "../session/types.js";
import { TODO_CUSTOM_TYPE, type TodoItem } from "../tools/todo.js";
import type { SessionCore } from "./session-core.js";
import type { SessionExtension, SessionExtensionFactory } from "./session-extensions.js";
import type {
  PlanData,
  PlanDecisionKind,
  PromptDisposition,
  PromptOptions,
  SessionEvent,
  TodoItemView,
} from "./types.js";

export function createPlanExtensionFactory(options: PlanExtensionOptions): SessionExtensionFactory {
  return ({ core }) => (core.depth > 0 ? undefined : new PlanExtension(core, options));
}

/** 会话对象上本扩展用到的公开方法（core 就是 AgentSessionImpl）。 */
interface SessionHandle {
  prompt(text: string, options?: PromptOptions): Promise<PromptDisposition>;
  setPermissionMode(mode: PermissionMode): void;
  setModel(ref: string): Promise<void>;
  setThinkingLevel(level: ModelThinkingLevel): void;
  waitForIdle(): Promise<void>;
}

class PlanExtension implements SessionExtension, PlanController {
  readonly id = "plan";
  private readonly permission: PermissionPipelineApi | undefined;
  private attendance: PlanAttendance;
  private handler: PlanDecisionHandler | undefined;
  private lastMode: PermissionMode;
  private inPlan = false;
  private pre: PermissionMode = "default";
  private planId: string | undefined;
  private promptIndex = 0;
  private forceFull = false;
  private pendingExit = false;
  private pendingHandoff: string | undefined;
  private stateDirty = false;
  private approving = false;
  private lastSource: string | undefined;
  private justProposed: PlanData | undefined;
  private executionModel: string | undefined;
  private executionThinking: ModelThinkingLevel | undefined;

  constructor(
    private readonly core: SessionCore,
    private readonly options: PlanExtensionOptions,
  ) {
    this.permission = core.options.permission;
    this.attendance = options.attendance ?? "unattended";
    const bash = options.config?.bash;
    const pipeline = this.permission as { setPlanBash?(mode: string): void } | undefined;
    if (bash !== undefined) pipeline?.setPlanBash?.(bash);
    this.lastMode = this.permission?.mode ?? "default";
    this.restore();
    registerPlanController(core, this);
  }

  // -------------------------------------------------------------------------
  // 恢复与模式跟踪
  // -------------------------------------------------------------------------

  private restore(): void {
    const branch = this.core.manager.branch();
    const state = latestPlanState(branch);
    const pending = latestPlan(branch);
    if (pending !== undefined) this.lastSource = pending.sourceEntryId;
    if (state?.active === true) {
      this.inPlan = true;
      this.pre = state.prePlanMode;
      this.planId = state.planId;
      if (state.executionModel !== undefined) this.executionModel = state.executionModel;
      if (state.executionThinking !== undefined)
        this.executionThinking = state.executionThinking as ModelThinkingLevel;
      if (this.permission !== undefined && this.permission.mode !== "plan")
        this.permission.setMode("plan");
      this.lastMode = "plan";
      // 已投递过的提示按 plan_state 之后的 user 消息计数，提醒节奏接着走
      const at = branch.findLastIndex(
        (e) => e.type === "custom" && e.customType === PLAN_STATE_CUSTOM_TYPE,
      );
      this.promptIndex = branch
        .slice(at + 1)
        .filter((e) => e.type === "message" && e.message.role === "user").length;
    } else if (this.lastMode === "plan") {
      this.inPlan = true;
      this.planId = randomUUID();
      this.stateDirty = true;
    }
  }

  private handle(): SessionHandle | undefined {
    const candidate = this.core as unknown as Partial<SessionHandle>;
    return typeof candidate.prompt === "function" &&
      typeof candidate.setPermissionMode === "function"
      ? (candidate as SessionHandle)
      : undefined;
  }

  private writeState(active: boolean): void {
    const data: PlanStateRecord = { active, prePlanMode: this.pre };
    if (this.planId !== undefined) data.planId = this.planId;
    if (active && this.executionModel !== undefined) data.executionModel = this.executionModel;
    if (active && this.executionThinking !== undefined)
      data.executionThinking = this.executionThinking;
    this.core.appendEntry({ type: "custom", customType: PLAN_STATE_CUSTOM_TYPE, data });
  }

  private onModeChanged(mode: PermissionMode): void {
    const previous = this.lastMode;
    this.lastMode = mode;
    if (mode === "plan" && !this.inPlan) {
      this.inPlan = true;
      this.pre = previous === "plan" ? "default" : previous;
      this.planId = randomUUID();
      this.promptIndex = 0;
      this.pendingExit = false;
      this.stateDirty = false;
      this.writeState(true);
    } else if (mode !== "plan" && this.inPlan) {
      this.inPlan = false;
      if (!this.approving) this.pendingExit = true;
      this.stateDirty = false;
      this.writeState(false);
    }
  }

  // -------------------------------------------------------------------------
  // 扩展钩子
  // -------------------------------------------------------------------------

  onEvent(event: SessionEvent): void {
    switch (event.type) {
      case "permission_mode_changed":
        this.onModeChanged(event.mode);
        break;
      case "compaction_end":
        if (event.result !== undefined) this.forceFull = true;
        break;
      case "entry_appended":
        if (event.entry.type === "custom" && event.entry.customType === TODO_CUSTOM_TYPE)
          this.core.emit({ type: "todo_updated", items: currentTodos(this.core.manager.branch()) });
        break;
      case "turn_end":
        if (this.inPlan && event.toolResults.length === 0 && event.message.stopReason === "stop")
          this.proposeFromLastAssistant(true);
        break;
      default:
        break;
    }
  }

  beforePrompts(_ctx: unknown, prompts: readonly AgentMessage[]): AgentMessage[] {
    const out: AgentMessage[] = [];
    if (this.stateDirty) {
      this.stateDirty = false;
      this.writeState(true);
    }
    const reply = this.textApproval(prompts);
    if (reply !== undefined) {
      out.push(planMessage(PLAN_APPROVED_TYPE, reply));
      return out;
    }
    if (this.pendingHandoff !== undefined) {
      out.push(planMessage(PLAN_APPROVED_TYPE, this.pendingHandoff));
      this.pendingHandoff = undefined;
      this.pendingExit = false;
      return out;
    }
    if (this.inPlan) {
      this.usePlanningModel();
      this.promptIndex++;
      const kind = this.forceFull ? "full" : reminderKind(this.promptIndex);
      this.forceFull = false;
      if (kind !== undefined)
        out.push(planMessage(PLAN_MODE_TYPE, kind === "full" ? PLAN_MODE_FULL : PLAN_MODE_BRIEF));
      return out;
    }
    this.restoreExecutionModel();
    if (this.pendingExit) {
      this.pendingExit = false;
      out.push(planMessage(PLAN_MODE_EXIT_TYPE, PLAN_MODE_EXIT));
    }
    return out;
  }

  onAgentSettled(): void {
    if (this.inPlan && this.lastSourceChanged()) this.proposeFromLastAssistant(false);
    const plan = this.justProposed;
    this.justProposed = undefined;
    if (plan === undefined) return;
    if (this.attendance === "text") this.showNotice(this.noticeText(plan));
    else if (this.attendance === "callback" && this.handler !== undefined) {
      const handler = this.handler;
      void (async () => {
        await this.handle()?.waitForIdle();
        const answer = await handler(plan);
        if (answer !== undefined) await this.respond({ ...answer, planId: plan.id });
      })().catch((error: unknown) => this.log("warn", `plan approval failed: ${String(error)}`));
    } else if (this.attendance === "unattended" && this.unattendedPolicy() === "stop") {
      this.log("info", `plan v${plan.version} awaits approval: ${plan.filePath ?? plan.id}`);
    }
  }

  dispose(): void {
    registerPlanController(this.core, undefined);
  }

  // -------------------------------------------------------------------------
  // 提取与提交审批
  // -------------------------------------------------------------------------

  private lastAssistantEntry(): { id: string; text: string } | undefined {
    const branch = this.core.manager.branch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]!;
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message;
      if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
      const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return { id: entry.id, text };
    }
    return undefined;
  }

  private lastSourceChanged(): boolean {
    const last = this.lastAssistantEntry();
    return last !== undefined && last.id !== this.lastSource;
  }

  private proposeFromLastAssistant(inRun: boolean): void {
    const last = this.lastAssistantEntry();
    if (last === undefined || last.id === this.lastSource) return;
    this.lastSource = last.id;
    const extracted = extractProposedPlan(last.text);
    if (extracted === undefined) return;
    const plan = this.propose(extracted, last.id);
    if (this.attendance === "unattended" && this.unattendedPolicy() === "approve") {
      const handoff = this.approve(plan, executionMode(undefined, this.pre), "approve");
      if (inRun) this.core.agent.followUp(planMessage(PLAN_APPROVED_TYPE, handoff));
      else {
        this.pendingHandoff = handoff;
        void this.deliver(PLAN_APPROVED_PROMPT, "plan");
      }
      return;
    }
    this.justProposed = plan;
  }

  proposeFromLastReply(): PlanData | undefined {
    const pending = this.pending();
    if (pending !== undefined) return pending;
    const last = this.lastAssistantEntry();
    if (last === undefined || last.text.trim() === "") return undefined;
    this.lastSource = last.id;
    return this.propose(extractProposedPlan(last.text) ?? planFromMarkdown(last.text), last.id);
  }

  private propose(extracted: ExtractedPlan, sourceEntryId: string): PlanData {
    const branch = this.core.manager.branch();
    const previous = latestPlan(branch);
    if (previous?.status === "proposed") this.appendPlan({ ...previous, status: "superseded" });
    if (extracted.truncated === true)
      this.log("warn", "plan has more than 30 steps; only the first 30 become todo items");
    this.planId ??= randomUUID();
    const plan: PlanData = {
      id: this.planId,
      version: maxPlanVersion(branch) + 1,
      status: "proposed",
      markdown: extracted.markdown,
      steps: extracted.steps,
      sourceEntryId,
    };
    const filePath = this.writeFile(plan);
    if (filePath !== undefined) plan.filePath = filePath;
    this.appendPlan(plan);
    const event: SessionEvent = {
      type: "plan_proposed",
      planId: plan.id,
      version: plan.version,
      markdown: plan.markdown,
      steps: plan.steps,
    };
    if (filePath !== undefined) event.filePath = filePath;
    this.core.emit(event);
    return plan;
  }

  private writeFile(plan: PlanData): string | undefined {
    const root = this.permission?.projectRoot ?? this.core.cwd;
    const { dataDir } = this.options;
    const configured = this.options.config?.directory;
    if (dataDir === undefined && configured === undefined) return undefined;
    const target = resolvePlanDirectory(configured, root, dataDir ?? root);
    if (target.warning !== undefined) this.log("warn", target.warning);
    try {
      return writePlanFile(target.dir, this.core.manager.id, plan.version, plan.markdown);
    } catch (error) {
      this.log("warn", `cannot write plan file: ${String(error)}`);
      return undefined;
    }
  }

  private appendPlan(plan: PlanData): void {
    this.core.appendEntry({ type: "custom", customType: PLAN_CUSTOM_TYPE, data: plan });
  }

  private unattendedPolicy(): "stop" | "approve" {
    return this.options.config?.unattended ?? "stop";
  }

  private showNotice(text: string): void {
    if (this.options.notice !== true) return;
    const message = { ...planMessage(PLAN_NOTICE_TYPE, text), display: true };
    this.core.emit({ type: "message_start", message });
  }

  private noticeText(plan: PlanData): string {
    const target = permissionModeLabel(executionMode(undefined, this.pre));
    const where = plan.filePath === undefined ? "" : `（${plan.filePath}）`;
    return `计划 v${plan.version} 待审批${where}：回复 1 批准并执行（${target}）· 2 以 Accept edits 执行 · 3 以 Auto 执行；回复其它内容作为修改意见，留在 Plan 模式。`;
  }

  // -------------------------------------------------------------------------
  // 审批与交接
  // -------------------------------------------------------------------------

  current(): PlanData | null {
    return latestPlan(this.core.manager.branch()) ?? null;
  }

  get(planId?: string): PlanData | null {
    return latestPlan(this.core.manager.branch(), planId) ?? null;
  }

  pending(): PlanData | undefined {
    const plan = latestPlan(this.core.manager.branch());
    return plan?.status === "proposed" ? plan : undefined;
  }

  todos(): TodoItemView[] {
    return currentTodos(this.core.manager.branch());
  }

  prePlanMode(): PermissionMode | undefined {
    return this.inPlan ? this.pre : undefined;
  }

  setAttendance(kind: PlanAttendance, handler?: PlanDecisionHandler): void {
    this.attendance = kind;
    this.handler = handler;
  }

  /** 交互模式：计划待审批时用户回复 1 / 2 / 3（等）即批准；返回交接文本。 */
  private textApproval(prompts: readonly AgentMessage[]): string | undefined {
    if (this.attendance !== "text" || !this.inPlan) return undefined;
    const plan = this.pending();
    const first = prompts[0];
    if (plan === undefined || first?.role !== "user") return undefined;
    const text =
      typeof first.content === "string"
        ? first.content
        : first.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const choice = APPROVE_REPLY[text.trim().toLowerCase()];
    if (choice === undefined) return undefined;
    const mode = choice === "pre" ? executionMode(undefined, this.pre) : choice;
    return this.approve(plan, mode, "approve");
  }

  async respond(response: PlanResponse): Promise<PlanResponseResult> {
    let plan = this.pending();
    if (plan === undefined || plan.id !== response.planId)
      throw new AmaError("plan_not_found", `no plan ${response.planId} is waiting for approval`);
    const { decision } = response;
    if (decision === "reject") {
      this.appendPlan({ ...plan, status: "rejected" });
      this.core.emit({ type: "plan_resolved", planId: plan.id, decision });
      return { planId: plan.id, decision, plan: { ...plan, status: "rejected" } };
    }
    if (decision === "revise") {
      this.core.emit({ type: "plan_resolved", planId: plan.id, decision });
      if (response.feedback !== undefined && response.feedback.trim() !== "")
        await this.deliver(response.feedback, undefined);
      return { planId: plan.id, decision, plan };
    }
    if (response.editedMarkdown !== undefined && response.editedMarkdown !== plan.markdown) {
      const edited =
        extractProposedPlan(response.editedMarkdown) ?? planFromMarkdown(response.editedMarkdown);
      plan = this.propose(edited, plan.sourceEntryId);
      this.justProposed = undefined;
    }
    const mode = executionMode(response.mode, this.inPlan ? this.pre : this.lastMode);
    if (decision === "approve_fresh") {
      this.approve(plan, mode, decision, false);
      return {
        planId: plan.id,
        decision,
        mode,
        plan: { ...plan, status: "approved" },
        freshPrompt: freshContextPrompt(plan),
      };
    }
    this.pendingHandoff = this.approve(plan, mode, decision);
    await this.deliver(PLAN_APPROVED_PROMPT, "plan");
    return { planId: plan.id, decision, mode, plan: { ...plan, status: "approved" } };
  }

  /** 落 approved、生成 todo、发 plan_resolved、切模式与执行模型；返回交接文本。 */
  private approve(
    plan: PlanData,
    mode: PermissionMode,
    decision: PlanDecisionKind,
    todos = true,
  ): string {
    const approved: PlanData = { ...plan, status: "approved" };
    this.appendPlan(approved);
    if (todos) this.writeTodos(plan);
    this.core.emit({ type: "plan_resolved", planId: plan.id, decision, mode });
    this.approving = true;
    try {
      if (this.inPlan) {
        const session = this.handle();
        if (session !== undefined) session.setPermissionMode(mode);
        else {
          this.permission?.setMode(mode);
          this.core.emit({ type: "permission_mode_changed", mode });
        }
      }
    } finally {
      this.approving = false;
    }
    this.pendingExit = false;
    this.restoreExecutionModel();
    return planApprovedText(plan);
  }

  private writeTodos(plan: PlanData): void {
    if (plan.steps.length === 0) return;
    const items: TodoItem[] = plan.steps.map((step, i) => ({
      id: step.id,
      text: step.text,
      status: i === 0 ? "in_progress" : "pending",
      planStep: step.id,
    }));
    this.core.appendEntry({ type: "custom", customType: TODO_CUSTOM_TYPE, data: { items } });
  }

  adopt(plan: PlanData): void {
    this.appendPlan({ ...plan, status: "approved" });
    this.lastSource = plan.sourceEntryId;
    this.writeTodos(plan);
  }

  /** 空闲时开一个新回合（运行中则等它结束）；新回合开始即返回。 */
  private async deliver(text: string, origin: string | undefined): Promise<void> {
    const session = this.handle();
    if (session === undefined) return;
    for (let attempt = 0; attempt < 20; attempt++) {
      await session.waitForIdle();
      let failure: unknown;
      session.prompt(text, origin === undefined ? {} : { origin }).catch((error: unknown) => {
        failure = error;
      });
      for (let i = 0; i < 3; i++) await Promise.resolve();
      if (failure instanceof AmaError && failure.code === "busy") continue;
      if (failure !== undefined) this.log("warn", `plan turn failed: ${String(failure)}`);
      return;
    }
    this.log("warn", "plan turn not started: session stayed busy");
  }

  // -------------------------------------------------------------------------
  // 规划 / 执行分模型（§6.4，缺省关）
  // -------------------------------------------------------------------------

  private usePlanningModel(): void {
    const ref = this.options.config?.model;
    const level = this.options.config?.thinkingLevel;
    if ((ref === undefined && level === undefined) || this.executionModel !== undefined) return;
    const session = this.handle();
    if (session === undefined) return;
    this.executionModel = formatModelRef(this.core.model());
    this.executionThinking = this.core.thinkingLevel();
    const failed = (error: unknown): void =>
      this.log("warn", `cannot switch to plan.model ${ref ?? ""}: ${String(error)}`);
    if (ref !== undefined && ref !== this.executionModel) session.setModel(ref).catch(failed);
    if (level !== undefined && level !== this.executionThinking) session.setThinkingLevel(level);
    this.writeState(true);
  }

  private restoreExecutionModel(): void {
    const ref = this.executionModel;
    const level = this.executionThinking;
    if (ref === undefined) return;
    this.executionModel = undefined;
    this.executionThinking = undefined;
    const session = this.handle();
    if (session === undefined) return;
    if (ref !== formatModelRef(this.core.model()))
      session
        .setModel(ref)
        .catch((error: unknown) =>
          this.log("warn", `cannot switch back to ${ref}: ${String(error)}`),
        );
    if (level !== undefined && level !== this.core.thinkingLevel()) session.setThinkingLevel(level);
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    (this.options.log ?? this.core.log.bind(this.core))(level, message);
  }
}

export {
  planController,
  type PlanAttendance,
  type PlanController,
  type PlanDecision,
  type PlanDecisionHandler,
  type PlanExtensionOptions,
  type PlanResponse,
  type PlanResponseResult,
} from "../plan/controller.js";
