/**
 * 计划控制面的类型与登记表（RPC / SDK / 界面通过 `planController(session)` 使用）。[W5-F]
 * 实现在 `agent/session-plan.ts`。
 */

import type { PlanData, PlanDecisionKind, TodoItemView } from "../agent/types.js";
import type { PlanConfig } from "../config/types-w5.js";
import type { PermissionMode } from "../permissions/types.js";

/**
 * 计划审批由谁回答：`text` 交互模式（回复 1 / 2 / 3 批准，其它文字即修改意见）；`client` RPC 客户端
 * 声明了 `plans` 能力（`plan_response`）；`callback` SDK `plan.onProposed`；`unattended` 按
 * `plan.unattended`。
 */
export type PlanAttendance = "text" | "client" | "callback" | "unattended";

/** 审批回答（RPC `plan_response` 同构）。 */
export interface PlanResponse {
  planId: string;
  decision: PlanDecisionKind;
  mode?: PermissionMode;
  feedback?: string;
  editedMarkdown?: string;
}

/** SDK 回调的返回：不带 planId 的回答；undefined = 不作答（计划留在 proposed）。 */
export type PlanDecision = Omit<PlanResponse, "planId">;
export type PlanDecisionHandler = (plan: PlanData) => Promise<PlanDecision | undefined>;

export interface PlanResponseResult {
  planId: string;
  decision: PlanDecisionKind;
  /** 批准后的执行模式。 */
  mode?: PermissionMode;
  /** 最终计划（编辑过则是新版本）。 */
  plan: PlanData;
  /** `approve_fresh`：新会话的首条用户消息（调用方新建会话后先 `adopt(plan)` 再发它）。 */
  freshPrompt?: string;
}

/** RPC / SDK / 界面使用的计划控制面（`planController(session)` 取得）。 */
export interface PlanController {
  /** 分支上最近的计划（任意状态）；没有为 null。 */
  current(): PlanData | null;
  get(planId?: string): PlanData | null;
  /** 等待审批的计划（最近一条且 status = proposed）。 */
  pending(): PlanData | undefined;
  todos(): TodoItemView[];
  /** 进入 plan 前的模式（不在 plan 时 undefined）。 */
  prePlanMode(): PermissionMode | undefined;
  respond(response: PlanResponse): Promise<PlanResponseResult>;
  /** `/plan approve` 的回退：回复里没有计划块时把上一条回复当作计划提交审批。 */
  proposeFromLastReply(): PlanData | undefined;
  /** 「新上下文执行」的新会话：记下获批计划并生成 todo。 */
  adopt(plan: PlanData): void;
  setAttendance(kind: PlanAttendance, handler?: PlanDecisionHandler): void;
}

export interface PlanExtensionOptions {
  config?: PlanConfig;
  /** 计划文件缺省目录 `<dataDir>/plans`；不给且没有 `plan.directory` 时不写文件。 */
  dataDir?: string;
  /** 缺省 unattended。 */
  attendance?: PlanAttendance;
  /**
   * 交互模式（无宿主）在计划待审批时显示一行文本提示：以不落盘的 `message_start`（custom、
   * `display:true`）事件发出，TUI 显示为提示行。正式的审批框归 W5-U。
   */
  notice?: boolean;
  log?(level: "debug" | "info" | "warn" | "error", message: string): void;
}

const controllers = new WeakMap<object, PlanController>();

/** 扩展构造时登记（键 = 会话对象），dispose 时撤下。 */
export function registerPlanController(
  session: object,
  controller: PlanController | undefined,
): void {
  if (controller === undefined) controllers.delete(session);
  else controllers.set(session, controller);
}

/** 会话的计划控制面；会话没有装 plan 扩展（子会话、SDK 自装配）时 undefined。 */
export function planController(session: object): PlanController | undefined {
  return controllers.get(session);
}

/** 文本提示行（只发事件，不落盘、不进上下文）。 */
export const PLAN_NOTICE_TYPE = "ama.plan_notice";

export const APPROVE_REPLY: Readonly<Record<string, PermissionMode | "pre">> = {
  "1": "pre",
  y: "pre",
  yes: "pre",
  approve: "pre",
  批准: "pre",
  "2": "auto-edit",
  "3": "auto",
};
