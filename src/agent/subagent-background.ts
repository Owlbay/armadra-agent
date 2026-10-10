/**
 * 子 Agent 的后台化（docs/agents-concurrency-plan.md §2.3、§2.5–§2.6）。[W7-B1]
 *
 * 从 subagent-registry.ts 拆出（保持 ≤ 600 行）：
 * - `resolveTaskBackground`：`subagents.background`（auto / always / never）→ 本会话 `task` 的缺省；
 * - 工具结果：`startedResult`（直接后台）、`backgroundedResult`（前台转后台；固定英文文案在
 *   agents/result.ts）；
 * - `foregroundWaiter`：前台任务的等待者——转后台时以固定文案先行 resolve 工具调用，并解绑父 signal；
 * - `WaitDetach`：`task_ctl wait` 的打断信号（`background()` 触发，按 taskId 或全部）；
 * - `TaskNotifier`：完成通知的串行投递——父会话空闲后以 followUp（origin task）开一轮；用户的 steer /
 *   followUp 总在通知之前（通知只在空闲时入场），收尾阶段入队的由 W5-H2 的同周期续投接住；每个通知
 *   各开一轮，不合并。
 */

import type { TaskRecord } from "../agents/task-record.js";
import { backgroundedText, startedText, taskNotification } from "../agents/result.js";
import type { SubagentResult, SubagentStatus } from "../tools/types.js";
import type { SubagentBackgroundEvent } from "./types-w5.js";
import { ZERO_USAGE } from "./loop.js";

export type BackgroundReason = "user" | "timeout" | "host";
export type BackgroundSetting = "auto" | "always" | "never";

/** `auto`：交互 / RPC / ACP 缺省后台，`-p`（无人值守）缺省前台。 */
export function resolveTaskBackground(
  setting: BackgroundSetting | undefined,
  unattended: boolean,
): boolean {
  if (setting === "always") return true;
  if (setting === "never") return false;
  return !unattended;
}

function runningResult(record: TaskRecord, text: string, outputFile?: string): SubagentResult {
  const result: SubagentResult = {
    text,
    usage: { ...ZERO_USAGE },
    stopReason: "stop",
    isError: false,
    taskId: record.info.taskId,
    status: "running",
  };
  if (outputFile !== undefined) result.outputFile = outputFile;
  // #156：fork / fresh 已定时带上实际模式（与完成结果的 details.context 同源）
  if (record.info.context !== undefined) result.context = record.info.context;
  return result;
}

/**
 * 直接后台的工具结果。`settle`（任务的运行 promise）给出时先等一个宏任务：ama 子会话在第一个
 * await 之前就发出 `context` 事件，池有空位时此刻模式已知；排队或 worktree 隔离未就绪时不带。
 */
export async function startedResult(
  record: TaskRecord,
  outputFile?: string,
  settle?: Promise<unknown>,
): Promise<SubagentResult> {
  if (settle !== undefined)
    await Promise.race([
      settle.catch(() => undefined),
      new Promise<void>((resolve) => setImmediate(resolve)),
    ]);
  return runningResult(record, startedText(record.info.taskId, record.agent.name), outputFile);
}

export function backgroundedResult(
  record: TaskRecord,
  reason: BackgroundReason,
  afterMs: number,
  outputFile?: string,
): SubagentResult {
  return runningResult(record, backgroundedText(reason, afterMs), outputFile);
}

/** 前台任务的等待者：`resolve` 让工具调用先返回，`detachParent` 解绑父 signal 与进度回调。 */
export function foregroundWaiter(detachParent: () => void): {
  waiter: NonNullable<TaskRecord["foregroundWaiter"]>;
  promise: Promise<SubagentResult>;
} {
  let resolve!: (result: SubagentResult) => void;
  const promise = new Promise<SubagentResult>((r) => {
    resolve = r;
  });
  return { waiter: { resolve, detachParent }, promise };
}

/** `task_ctl wait` 的打断信号：每个 taskId 一个，`detach` 后换新。 */
export class WaitDetach {
  private readonly controllers = new Map<string, AbortController>();
  private readonly waiting = new Map<string, number>();

  signal(taskId: string): AbortSignal {
    let controller = this.controllers.get(taskId);
    if (controller === undefined) {
      controller = new AbortController();
      this.controllers.set(taskId, controller);
    }
    return controller.signal;
  }

  /** 登记一次正在进行的 wait；返回注销函数。 */
  enter(taskId: string): () => void {
    this.waiting.set(taskId, (this.waiting.get(taskId) ?? 0) + 1);
    return () => {
      const left = (this.waiting.get(taskId) ?? 1) - 1;
      if (left <= 0) this.waiting.delete(taskId);
      else this.waiting.set(taskId, left);
    };
  }

  /** 有 wait 在等的 taskId。 */
  waited(): string[] {
    return [...this.waiting.keys()];
  }

  /** 打断 `taskId`（缺省全部）上的 wait；返回被打断的 taskId。 */
  detach(taskId?: string): string[] {
    const ids = taskId === undefined ? this.waited() : this.waiting.has(taskId) ? [taskId] : [];
    for (const id of taskId === undefined ? [...this.controllers.keys()] : [taskId]) {
      this.controllers.get(id)?.abort();
      this.controllers.delete(id);
    }
    return ids;
  }
}

export interface NotifierHost {
  followUp?(text: string, options?: { origin?: string }): Promise<unknown>;
  waitForIdle?(): Promise<void>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

/** 完成通知的串行投递（按完成顺序；父空闲时投递，每个通知各开一轮）。 */
export class TaskNotifier {
  private delivery: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: NotifierHost,
    private readonly disposed: () => boolean,
  ) {}

  /** 当前投递链（含已入链通知的整个回合）。 */
  pending(): Promise<void> {
    return this.delivery;
  }

  notify(record: TaskRecord, result: SubagentResult): void {
    // 被停止的任务（task_ctl stop、会话关闭）不再通知：发起停止的一方已经知道
    if (this.disposed() || result.status === "aborted") return;
    const info = record.info;
    const text = taskNotification({
      taskId: info.taskId,
      agent: info.agent,
      status: (result.status ?? "completed") as SubagentStatus,
      ...(info.turns === undefined ? {} : { turns: info.turns }),
      ...(info.usage === undefined ? {} : { usage: info.usage }),
      ...(info.outputFile === undefined ? {} : { outputFile: info.outputFile }),
      report: result.text,
    });
    const host = this.host;
    const followUp = host.followUp;
    if (followUp === undefined) {
      host.log("warn", `task ${info.taskId} finished but the session cannot be notified`);
      return;
    }
    // 父空闲时投递（开新回合）；父正忙则等这一周期结束再投——周期收尾阶段入队的 followUp 由同周期续投
    // 接住（W5-H2）。串行投递保证按完成顺序到达、各开一轮。
    this.delivery = this.delivery
      .then(async () => {
        await host.waitForIdle?.();
        if (!this.disposed()) await followUp.call(host, text, { origin: "task" });
      })
      .catch((error: unknown) => host.log("warn", `task notification failed: ${String(error)}`));
  }
}

/** 等任务结束、超时或 signal 触发（后两者返回 undefined）；登记进 `waits` 供 `blocking()` 查看。 */
export async function waitForTask(
  record: TaskRecord,
  timeoutMs: number,
  signal: AbortSignal,
  waits: WaitDetach,
): Promise<SubagentResult | undefined> {
  const running = record.running;
  if (running === undefined) return record.last;
  if (signal.aborted) return undefined;
  const leave = waits.enter(record.info.taskId);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([running, stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    leave();
  }
}

/** 运行中的前台任务与有 `task_ctl wait` 在等的任务。 */
export function blockingTasks(records: Iterable<TaskRecord>, waits: WaitDetach): string[] {
  const ids: string[] = [];
  for (const r of records)
    if (r.foregroundWaiter !== undefined && r.running !== undefined) ids.push(r.info.taskId);
  return [...new Set([...ids, ...waits.waited()])];
}

export interface BackgroundContext {
  emit(event: SubagentBackgroundEvent): void;
  persist(record: TaskRecord): void;
  notify(record: TaskRecord, result: SubagentResult): void;
  /** 超时转后台的阈值（文案里的秒数）。 */
  afterMs: number;
  outputFile(taskId: string): string | undefined;
}

/**
 * 前台 → 后台（§2.5.2）：只动运行中、仍在前台的任务；置后台、落快照、解绑父 signal、发事件、完成后通知、
 * 让工具调用以固定文案返回。以 `info.status` 为准——已收尾的任务不动（与结束竞争时先到者为准）。
 */
export function backgroundRecords(
  records: readonly TaskRecord[],
  reason: BackgroundReason,
  ctx: BackgroundContext,
): string[] {
  const moved: string[] = [];
  for (const record of records) {
    const waiter = record.foregroundWaiter;
    const running = record.running;
    if (waiter === undefined || running === undefined || record.info.status !== "running") continue;
    delete record.foregroundWaiter;
    record.info.background = true;
    waiter.detachParent();
    ctx.persist(record);
    const taskId = record.info.taskId;
    ctx.emit({
      type: "subagent_background",
      taskId,
      parentToolCallId: record.parentToolCallId,
      reason,
    });
    void running.then((result) => ctx.notify(record, result));
    waiter.resolve(backgroundedResult(record, reason, ctx.afterMs, ctx.outputFile(taskId)));
    moved.push(taskId);
  }
  return moved;
}

/** 等到没有运行中的任务、投递链也已结束（通知回合里新起的任务继续等）；会话关闭立即返回。 */
export async function settleTasks(
  tasks: ReadonlyMap<string, TaskRecord>,
  notifier: TaskNotifier,
  disposed: () => boolean,
): Promise<void> {
  const running = (): Promise<SubagentResult>[] =>
    [...tasks.values()].flatMap((r) => (r.running === undefined ? [] : [r.running]));
  for (;;) {
    if (disposed()) return;
    const now = running();
    if (now.length > 0) {
      await Promise.allSettled(now);
      continue;
    }
    const delivery = notifier.pending();
    await delivery;
    if (delivery === notifier.pending() && running().length === 0) return;
  }
}
