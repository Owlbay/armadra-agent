/**
 * 子 Agent 任务记录：并发池、单条任务的状态、runner 进度 → `subagent_update`、父会话
 * `custom{ama.task}` 快照的写入形状与 resume 重建（docs/wave5-plan.md §7.4–§7.5）。[W5-G]
 * 编排在 agent/subagent-registry.ts。
 */

import type { SubagentUpdateEvent } from "../agent/types-w5.js";
import type { Worktree, WorktreeOutcome } from "../agent/worktree.js";
import { AmaError } from "../errors.js";
import type { SessionEntry } from "../session/types.js";
import type {
  RunnerHandle,
  SubagentEvent,
  SubagentRequest,
  SubagentResult,
  TaskInfo,
} from "../tools/types.js";
import { DEFAULT_AGENT } from "./builtin.js";
import type { AgentCatalog } from "./catalog.js";
import type { AgentDefinition } from "./types.js";

export const TASK_CUSTOM_TYPE = "ama.task";
/** `subagent_update{kind:"text"}` 的合并间隔。 */
export const TEXT_THROTTLE_MS = 250;

/** 计数信号量；`waiting` 供排队上限判断；排队中 abort → 抛 aborted 并让出位置。 */
export class SubagentPool {
  private running = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  get waiting(): number {
    return this.waiters.length;
  }

  async acquire(signal: AbortSignal): Promise<void> {
    while (this.running >= this.limit) {
      if (signal.aborted) throw new AmaError("aborted", "aborted");
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal.removeEventListener("abort", wake);
          const at = this.waiters.indexOf(wake);
          if (at >= 0) this.waiters.splice(at, 1);
          resolve();
        };
        this.waiters.push(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    if (signal.aborted) throw new AmaError("aborted", "aborted");
    this.running++;
  }

  release(): void {
    this.running--;
    this.waiters[0]?.();
  }
}

/** ama runner 的创建参数（registry → session-subagent.ts）。 */
export interface AmaRunnerSpec {
  taskId: string;
  agent: AgentDefinition;
  request: SubagentRequest;
  /** `provider/model`；undefined = 继承父。 */
  modelRef?: string;
  cwd: string;
  /** 续聊被释放 / resume 后的任务：重开这个子会话文件。 */
  resumeFile?: string;
  /** worktree 里运行：不记父会话检查点。 */
  isolated: boolean;
}

/** runner 句柄的可选扩展（ama 子会话提供）。 */
export type TaskHandle = RunnerHandle & {
  readonly sessionFile?: string;
  readonly model?: string;
  dispose?(): Promise<void>;
};

export interface TaskRecord {
  info: TaskInfo;
  agent: AgentDefinition;
  parentToolCallId: string;
  isolation: "none" | "worktree";
  cwd: string;
  modelRef?: string;
  handle?: TaskHandle;
  running?: Promise<SubagentResult>;
  controller?: AbortController;
  /** 本次运行的文本（运行中是已有输出，结束后是最终文本）。 */
  text: string;
  pendingText: string;
  lastFlush: number;
  worktree?: Worktree;
  worktreeOutcome?: WorktreeOutcome;
  last?: SubagentResult;
  onUpdate?: (partial: string) => void;
}

export function newRecord(
  info: TaskInfo,
  agent: AgentDefinition,
  parentToolCallId: string,
  cwd: string,
  isolation: "none" | "worktree" = "none",
): TaskRecord {
  return { info, agent, parentToolCallId, isolation, cwd, text: "", pendingText: "", lastFlush: 0 };
}

export interface ProgressSink {
  emit(event: SubagentUpdateEvent): void;
  log(level: "info" | "warn", message: string): void;
  now(): number;
}

export function flushText(record: TaskRecord, sink: ProgressSink): void {
  if (record.pendingText === "") return;
  sink.emit({
    type: "subagent_update",
    taskId: record.info.taskId,
    kind: "text",
    textDelta: record.pendingText,
    turn: record.info.turns ?? 0,
  });
  record.pendingText = "";
  record.lastFlush = sink.now();
}

/** runner 进度 → 记录与 `subagent_update`（文本 ≥ 250 ms 合并，轮次与结束时冲刷）。 */
export function applyRunnerEvent(
  record: TaskRecord,
  event: SubagentEvent,
  sink: ProgressSink,
): void {
  const taskId = record.info.taskId;
  switch (event.type) {
    case "text":
      record.text += event.delta;
      record.pendingText += event.delta;
      if (sink.now() - record.lastFlush >= TEXT_THROTTLE_MS) flushText(record, sink);
      return;
    case "tool":
      if (event.status !== "started") return;
      record.onUpdate?.(`[task] ${event.toolName}`);
      sink.emit({
        type: "subagent_update",
        taskId,
        kind: "tool",
        toolName: event.toolName,
        turn: record.info.turns ?? 0,
      });
      return;
    case "turn": {
      flushText(record, sink);
      record.info.turns = event.turn;
      const update: SubagentUpdateEvent = {
        type: "subagent_update",
        taskId,
        kind: "turn",
        turn: event.turn,
      };
      if (record.info.usage !== undefined) update.usage = record.info.usage;
      sink.emit(update);
      return;
    }
    case "usage":
      if (event.usage !== undefined) record.info.usage = event.usage;
      if (event.unit === "usd" && event.amount !== undefined) record.info.costUsd = event.amount;
      return;
    case "notice":
      sink.log(event.level, `[task ${taskId}] ${event.text}`);
      return;
    default:
      return;
  }
}

/** 父会话 `custom{ama.task}` 的 data：TaskInfo + 父 toolCallId + 运行目录（带 `status`）。 */
export function recordData(record: TaskRecord): Record<string, unknown> {
  return { ...record.info, parentToolCallId: record.parentToolCallId, cwd: record.cwd };
}

/** 从父会话分支重建（同一 taskId 取最后一条；未结束的标 interrupted）；返回最大序号。 */
export function rebuildRecords(
  branch: readonly SessionEntry[],
  catalog: AgentCatalog,
  cwd: string,
): { records: Map<string, TaskRecord>; seq: number } {
  const records = new Map<string, TaskRecord>();
  let seq = 0;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== TASK_CUSTOM_TYPE) continue;
    // 子会话自己的首条 ama.task 没有 status，跳过
    const data = entry.data as Partial<TaskInfo & { parentToolCallId: string; cwd: string }>;
    if (typeof data.taskId !== "string" || data.status === undefined) continue;
    const { parentToolCallId = "", cwd: runCwd = cwd, ...rest } = data;
    const info = { ...rest } as TaskInfo;
    if (info.status === "running") info.status = "interrupted";
    const agent = catalog.get(info.agent) ?? {
      ...(catalog.get(DEFAULT_AGENT) as AgentDefinition),
      name: info.agent,
    };
    records.set(info.taskId, newRecord(info, agent, parentToolCallId, runCwd));
    const n = /^t(\d+)$/.exec(info.taskId);
    if (n !== null) seq = Math.max(seq, Number(n[1]));
  }
  return { records, seq };
}
