/**
 * default 模式下 `task(agent="claude")` 会问两次：task 工具调用一次，外部 Agent 本会话首次运行再一次
 * （agents/external.ts 的 `firstRun`）。界面层把它们合并成一次确认。[W5-U]
 *
 * 规则（不放宽权限语义）：
 * - 用户在对话框里**允许**了一次 `task` 工具调用，且它的 `agent` 是外部 Agent（类型的 runner 不是
 *   ama）——对话框已把「以你在该 CLI 的登录运行」写在正文里——记下 `{agent, 时刻}`；
 * - **紧接着**的下一个审批请求若是同一 Agent 的首次运行确认（`toolName: "task"`、输入带 `note`），其
 *   `context.taskId` 对应的任务是该 Agent、且在允许之后才建立（同一次调用产生的任务），并在 60 s 内
 *   到达，就以「允许」自动答复，不再弹框；
 * - 记录只用一次；中间夹了任何别的审批请求、拒绝、超时，都作废——首次运行确认照常弹出。
 */

import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "../../permissions/types.js";
import { taskRegistryView } from "../../agent/subagent-registry.js";
import { isFirstRunRequest } from "./approval-dialog.js";
import { listAgents } from "./tasks-report.js";

export const MERGE_WINDOW_MS = 60_000;

export interface FirstRunMergeDeps {
  sessionId(): string;
  now?(): number;
  /** 类型名 → runner（`ama` / `claude` / …）；缺省查会话的类型表。 */
  runnerOf?(agent: string): string | undefined;
  /** 任务 id → 类型名与建立时刻；缺省查注册表。 */
  taskOf?(taskId: string): { agent: string; startedAt: number } | undefined;
  windowMs?: number;
}

function input(request: ApprovalRequest): Record<string, unknown> {
  const value = request.input;
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export class FirstRunMerge {
  private pending: { agent: string; at: number } | undefined;

  constructor(private readonly deps: FirstRunMergeDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** `task` 调用的 agent 是外部 Agent 时返回它的 runner。 */
  externalRunner(agent: string): string | undefined {
    const runner =
      this.deps.runnerOf?.(agent) ??
      listAgents(this.deps.sessionId()).find((a) => a.name === agent)?.runner;
    return runner === undefined || runner === "ama" ? undefined : runner;
  }

  private taskOf(taskId: string): { agent: string; startedAt: number } | undefined {
    if (this.deps.taskOf !== undefined) return this.deps.taskOf(taskId);
    return taskRegistryView(this.deps.sessionId())?.get(taskId);
  }

  /** 请求到来：命中合并返回 `allow`（不弹框）；否则返回 undefined，并作废记录。 */
  intercept(request: ApprovalRequest): ApprovalDecision | undefined {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined || !isFirstRunRequest(request)) return undefined;
    if (this.now() - pending.at > (this.deps.windowMs ?? MERGE_WINDOW_MS)) return undefined;
    const taskId = request.context?.taskId;
    if (taskId === undefined || request.context?.origin !== undefined) return undefined;
    const task = this.taskOf(taskId);
    if (task === undefined || task.agent !== pending.agent || task.startedAt < pending.at)
      return undefined;
    const runner = this.externalRunner(pending.agent);
    if (runner === undefined || input(request)["agent"] !== runner) return undefined;
    return "allow";
  }

  /** 用户答复之后：允许了外部 Agent 的 task 调用就记下。 */
  record(request: ApprovalRequest, decision: ApprovalDecision | undefined): void {
    this.pending = undefined;
    if (decision !== "allow" && decision !== "allow_session") return;
    if (request.toolName !== "task" || isFirstRunRequest(request)) return;
    if ((request.context?.depth ?? 0) > 0 || request.context?.origin !== undefined) return;
    const agent = input(request)["agent"];
    if (typeof agent !== "string" || this.externalRunner(agent) === undefined) return;
    this.pending = { agent, at: this.now() };
  }
}

/** 把合并规则套在界面 broker 外面；自动答复时调 `onMerged`（消息区一行说明）。 */
export function mergingBroker(
  inner: ApprovalBroker,
  merge: FirstRunMerge,
  onMerged?: (request: ApprovalRequest) => void,
): ApprovalBroker {
  return {
    async ask(request, signal) {
      const merged = merge.intercept(request);
      if (merged !== undefined) {
        onMerged?.(request);
        return merged;
      }
      const decision = await inner.ask(request, signal);
      merge.record(request, decision);
      return decision;
    },
  };
}
