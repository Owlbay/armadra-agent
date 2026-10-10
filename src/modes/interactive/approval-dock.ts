/**
 * 后台任务的审批停靠（docs/history/agents-concurrency-plan.md §2.7、D6）。[W7-C]
 *
 * 套在审批对话框 broker 外面：请求带 `context.taskId` 且该任务在后台运行（含转后台）时，主会话忙、输入框有
 * 草稿或已有覆盖层就不弹框，先「停靠」——Agent 栏该任务行显示「等待审批」（agent-ui.ts 按
 * `permission_request` 记下），运行提示行附「↓ 处理审批」；满足下列任一条件立即弹出：
 * - 主会话空闲、输入为空、没有覆盖层（`ready`，每 250 ms 与相关事件后各对一次）；
 * - 正在子 Agent 视图里看这个任务（栏里 Enter 打开视图即弹出）；
 * - 停靠期间又来了不能停靠的请求（主会话自己的、前台任务的）：审批链是串行的，它排在停靠的请求后面，
 *   不放出来就会一直等，所以先弹停靠的那个——主会话与前台任务的审批照旧立即弹出。
 *
 * 停靠期间子任务阻塞在权限等待；超时 / 取消（链的 signal）照旧，停靠项随之撤掉、按 undefined 交回链。
 * 前台任务与主会话的请求直接交给内层 broker，行为不变。
 */

import type { SessionEvent } from "../../agent/types.js";
import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "../../permissions/types.js";

export const DOCK_POLL_MS = 250;

export interface DockHost {
  /** 任务在后台运行（停靠候选）。 */
  dockable(taskId: string): boolean;
  /** 现在可以弹出这个任务的审批（主会话空闲且空输入且无覆盖层，或正在看它的视图）。 */
  ready(taskId: string): boolean;
  /** 停靠集合变了（栏与运行提示行重画）。 */
  changed(): void;
  pollMs?: number;
}

interface Docked {
  taskId: string;
  request: ApprovalRequest;
  signal: AbortSignal;
  resolve(decision: Promise<ApprovalDecision | undefined> | undefined): void;
  onAbort(): void;
}

export class ApprovalDock implements ApprovalBroker {
  private readonly docked: Docked[] = [];
  /** 已发出、还没答复的不可停靠请求（主会话 / 前台任务）。 */
  private readonly others = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly inner: ApprovalBroker,
    private readonly host: DockHost,
  ) {}

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | undefined> {
    const taskId = request.context?.taskId;
    if (
      taskId === undefined ||
      signal.aborted ||
      !this.host.dockable(taskId) ||
      this.others.size > 0 ||
      this.host.ready(taskId)
    )
      return this.inner.ask(request, signal);
    return new Promise((resolve) => {
      const entry: Docked = {
        taskId,
        request,
        signal,
        resolve,
        onAbort: () => {
          this.remove(entry);
          resolve(undefined);
        },
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.docked.push(entry);
      this.startPolling();
      this.host.changed();
    });
  }

  /** 停靠中的任务。 */
  tasks(): ReadonlySet<string> {
    return new Set(this.docked.map((entry) => entry.taskId));
  }

  get size(): number {
    return this.docked.length;
  }

  /** 会话事件：记下不可停靠的请求；停靠期间来了这种请求就放出停靠的（见文件头）。 */
  observe(event: SessionEvent): void {
    if (event.type === "permission_request") {
      const taskId = event.context?.taskId;
      if (taskId !== undefined && this.host.dockable(taskId)) return;
      this.others.add(event.requestId);
      this.poke();
    } else if (event.type === "permission_resolved") this.others.delete(event.requestId);
  }

  /** 对一次弹出条件（定时器、视图打开、回合结束）。 */
  poke(): void {
    for (const entry of [...this.docked])
      if (this.others.size > 0 || this.host.ready(entry.taskId)) this.release(entry);
  }

  /** 换会话：旧会话的未答复请求不再有 `permission_resolved` 到这里。 */
  reset(): void {
    this.others.clear();
  }

  /** 退出：停靠的请求按 undefined 交回链（链按拒绝处理）。 */
  dispose(): void {
    for (const entry of [...this.docked]) entry.onAbort();
    this.others.clear();
  }

  private release(entry: Docked): void {
    this.remove(entry);
    entry.resolve(this.inner.ask(entry.request, entry.signal));
  }

  private remove(entry: Docked): void {
    const at = this.docked.indexOf(entry);
    if (at < 0) return;
    this.docked.splice(at, 1);
    entry.signal.removeEventListener("abort", entry.onAbort);
    if (this.docked.length === 0) this.stopPolling();
    this.host.changed();
  }

  private startPolling(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.poke(), this.host.pollMs ?? DOCK_POLL_MS);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
