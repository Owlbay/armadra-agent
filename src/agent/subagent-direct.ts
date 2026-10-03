/**
 * 子 Agent 视图的直接对话与实时数据（docs/wave6-plan.md §1.2–§1.3、D3）。[W6-A]
 *
 * 从 subagent-registry.ts 拆出（保持 ≤ 600 行）：
 * - `liveOf`：视图读的快照、是否在并发池排队、ama 子会话的观察钩子与外部 Agent 的环形缓冲；
 * - `directMessage`：人在视图里发的消息——ama 运行中 → 子会话 followUp（回合结束投递，返回 `steered`）；
 *   外部 Agent 运行中 / 还在排队 → 等本次运行结束后续聊（`queued`）；已结束 → 同 `task_ctl send` 的后台续聊
 *   （`resumed`，完成后父会话照常收 `<task-notification>`）。子会话 user 消息记 `origin: "direct"`；
 * - `drainDirect`：运行结束时把排着的消息合成一条续聊；任务被停止时丢弃（停止的一方不想它再跑）。
 * - 打断并发送（`interrupt`）：ama 运行中 → 子会话 `prompt{interrupt}`（中止本轮、立即开新回合，`interrupted`）；
 *   外部 Agent 运行中且驱动能中断回合 → 连同排着的消息一起 `handle.interrupt`（`interrupted`）；驱动不能中断
 *   或任务还在并发池排队 → 照常排到运行结束（`queuedNoInterrupt`，视图提示）；已结束 → 同上的后台续聊。
 */

import { AmaError } from "../errors.js";
import type { TaskLive, TaskRecord } from "../agents/task-record.js";
import type { SubagentRequest, SubagentResult } from "../tools/types.js";

export type DirectReply = "steered" | "queued" | "resumed" | "interrupted" | "queuedNoInterrupt";

export interface DirectHost {
  spawnSubagent?(request: SubagentRequest): Promise<SubagentResult>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export function liveOf(record: TaskRecord): TaskLive {
  const handle = record.handle;
  const live: TaskLive = {
    info: { ...record.info },
    queued: record.queued === true,
    recent: handle?.recent?.() ?? record.ring?.items() ?? [],
    pending: record.direct?.length ?? 0,
  };
  const observe = handle?.observe;
  const entries = handle?.entries;
  if (observe !== undefined) live.observe = (listener) => observe.call(handle, listener);
  if (entries !== undefined) live.entries = () => entries.call(handle);
  return live;
}

export async function directMessage(
  record: TaskRecord,
  text: string,
  host: DirectHost,
  interrupt = false,
): Promise<DirectReply> {
  if (text.trim() === "") throw new AmaError("invalid_arguments", "empty message");
  if (record.running !== undefined) {
    const handle = record.handle;
    if (interrupt && record.queued !== true && (await interruptRun(record, text)))
      return "interrupted";
    if (interrupt) {
      (record.direct ??= []).push(text);
      return "queuedNoInterrupt";
    }
    if (handle?.message !== undefined && record.queued !== true) {
      try {
        await handle.message(text, "followUp");
        return "steered";
      } catch (error) {
        // 子会话这一轮刚结束、注册表还没收尾：排到运行结束后续聊
        if (!(error instanceof AmaError) || error.code !== "task_idle") throw error;
      }
    }
    (record.direct ??= []).push(text);
    return "queued";
  }
  await resumeDirect(record, text, host);
  return "resumed";
}

/** 打断运行中的任务并立即发送；做不到返回 false（不改动排队）。 */
async function interruptRun(record: TaskRecord, text: string): Promise<boolean> {
  const handle = record.handle;
  if (handle?.message !== undefined) {
    try {
      await handle.message(text, "interrupt");
      return true;
    } catch (error) {
      if (error instanceof AmaError && error.code === "task_idle") return false;
      throw error;
    }
  }
  if (handle?.interrupt === undefined) return false;
  // 外部 Agent：排着的消息（运行中在视图里发的）在前，一起作为新回合
  const queued = record.direct ?? [];
  const merged = [...queued, text].join("\n\n");
  if (!(await handle.interrupt(merged))) return false;
  queued.splice(0);
  return true;
}

async function resumeDirect(record: TaskRecord, text: string, host: DirectHost): Promise<void> {
  const spawn = host.spawnSubagent;
  if (spawn === undefined)
    throw new AmaError("unsupported", "this session cannot continue sub-agent tasks");
  record.directNext = true;
  const result = await spawn.call(host, {
    prompt: text,
    taskId: record.info.taskId,
    background: true,
    parentToolCallId: record.parentToolCallId,
    signal: new AbortController().signal,
  });
  if (result.isError) {
    delete record.directNext;
    throw new AmaError("task_not_resumable", result.text);
  }
}

export function drainDirect(record: TaskRecord, host: DirectHost): void {
  const queued = record.direct?.splice(0) ?? [];
  if (queued.length === 0) return;
  if (record.info.status === "aborted") {
    host.log(
      "info",
      `task ${record.info.taskId} was stopped; ${queued.length} queued message(s) dropped`,
    );
    return;
  }
  void resumeDirect(record, queued.join("\n\n"), host).catch((error: unknown) =>
    host.log("warn", `task ${record.info.taskId}: queued message failed: ${String(error)}`),
  );
}
