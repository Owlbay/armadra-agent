/**
 * 子 Agent 任务记录：并发池、单条任务的状态、runner 进度 → `subagent_update`、父会话
 * `custom{ama.task}` 快照的写入形状与 resume 重建（docs/wave5-plan.md §7.4–§7.5）。[W5-G]
 * 编排在 agent/subagent-registry.ts。
 */

import type {
  SessionTaskStats,
  SubagentStartEvent,
  SubagentUpdateEvent,
} from "../agent/types-w5.js";
import type { MessageOrigin } from "../ai/types.js";
import type { SessionEvent } from "../agent/types.js";
import type { TraceExternalTurnData } from "../trace/types.js";
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
  /** [W6-A] 首条 prompt 的 origin（子 Agent 视图里续聊已释放的子会话 = `"direct"`）。 */
  origin?: MessageOrigin;
}

/**
 * [W6-C0] 外部 Agent 的展示事件（`DriverEvent` 派生，子 Agent 视图用）：只在内存环形缓冲里（≤ 2000 条 /
 * 1 MB），不落盘（docs/wave6-plan.md §1.2、D2）。
 */
export interface ExternalDisplayEvent {
  at: number;
  kind: "text" | "thought" | "tool" | "notice" | "turn";
  text?: string;
  toolName?: string;
  toolId?: string;
  status?: "started" | "completed" | "failed";
  level?: "info" | "warn";
  turn?: number;
}

/** runner 句柄的可选扩展（ama 子会话提供；[W6-C0] 视图钩子由 W6-A 实现）。 */
export type TaskHandle = RunnerHandle & {
  readonly sessionFile?: string;
  readonly model?: string;
  dispose?(): Promise<void>;
  /** [W6-C0] ama 子会话的实时事件（子 Agent 视图跟随）；返回取消订阅。 */
  observe?(listener: (event: SessionEvent) => void): () => void;
  /** [W6-C0] ama 子会话当前分支的条目（视图全量渲染）。 */
  entries?(): readonly SessionEntry[];
  /** [W6-C0] 外部 Agent 的环形缓冲（W6-A）。 */
  recent?(): readonly ExternalDisplayEvent[];
  /**
   * [W6-A] 人在子 Agent 视图里直接发的消息（子会话 user 消息 `origin: "direct"`）：`followUp` = 本轮运行中
   * 排到回合结束（不在运行中抛 `task_idle`，由注册表排队到运行结束后续聊）；`send` = 空闲时开新一轮（同 `send`）；
   * `interrupt` = 打断子会话当前回合并立即以它开新回合（不在运行中同样抛 `task_idle`）。ama 子会话提供。
   */
  message?(text: string, when: "followUp" | "send" | "interrupt"): Promise<void>;
};

/** [W6-A] 外部 Agent 环形缓冲的上限（docs/wave6-plan.md D2）。 */
export const RING_MAX_EVENTS = 2000;
export const RING_MAX_BYTES = 1024 * 1024;

/**
 * [W6-A] 外部 Agent 展示事件的内存环形缓冲：相邻的同类文本（text / thought）合并成一条；超过条数或字节
 * 上限从最旧的丢。只在内存，不落盘（第五波 §5.4：外部 Agent 原始事件不进 JSONL）。
 */
export class DisplayRing {
  private readonly events: ExternalDisplayEvent[] = [];
  private bytes = 0;

  constructor(
    private readonly maxEvents = RING_MAX_EVENTS,
    private readonly maxBytes = RING_MAX_BYTES,
  ) {}

  get size(): number {
    return this.bytes;
  }

  items(): readonly ExternalDisplayEvent[] {
    return this.events;
  }

  push(event: ExternalDisplayEvent): void {
    const last = this.events.at(-1);
    const add = sizeOf(event);
    if (
      last !== undefined &&
      (event.kind === "text" || event.kind === "thought") &&
      last.kind === event.kind &&
      last.turn === event.turn
    ) {
      last.text = (last.text ?? "") + (event.text ?? "");
      this.bytes += add;
    } else {
      this.events.push({ ...event });
      this.bytes += add;
    }
    this.trim();
  }

  private trim(): void {
    while (this.events.length > this.maxEvents) this.drop();
    while (this.bytes > this.maxBytes && this.events.length > 1) this.drop();
    const only = this.events[0];
    if (this.bytes > this.maxBytes && only?.text !== undefined) {
      // 单条超过上限：保留尾部
      const keep = only.text.slice(only.text.length - Math.floor(this.maxBytes / 4));
      this.bytes = this.bytes - Buffer.byteLength(only.text) + Buffer.byteLength(keep);
      only.text = keep;
    }
  }

  private drop(): void {
    const first = this.events.shift();
    if (first !== undefined) this.bytes -= sizeOf(first);
  }
}

function sizeOf(event: ExternalDisplayEvent): number {
  return Buffer.byteLength(event.text ?? "") + Buffer.byteLength(event.toolName ?? "") + 32;
}

/** [W6-A] 子 Agent 视图读的一条任务的实时数据（`SubagentRegistry.live`）。 */
export interface TaskLive {
  info: TaskInfo;
  /** 还在并发池里排队（尚未开跑）。 */
  queued: boolean;
  /** ama 子会话的观察钩子（句柄在内存时）。 */
  observe?(listener: (event: SessionEvent) => void): () => void;
  entries?(): readonly SessionEntry[];
  /** 外部 Agent 的环形缓冲（本进程里跑过才有）。 */
  recent: readonly ExternalDisplayEvent[];
  /** 人在视图里发、等运行结束再续聊的消息数。 */
  pending: number;
}

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
  /** [W6-A] 在并发池里排队（acquire 之前）。 */
  queued?: boolean;
  /** [W6-A] 外部 Agent 的展示事件（内存环形缓冲）。 */
  ring?: DisplayRing;
  /** [W6-A] 视图里发来、等本次运行结束再续聊的消息。 */
  direct?: string[];
  /** [W6-A] 下一次续聊是人在视图里发的（子会话 user 消息记 `origin: "direct"`）。 */
  directNext?: boolean;
  /**
   * [W7-B1] 前台等待者：launch 时建，转后台时 resolve（工具调用先返回）；结束时删掉。
   * `detachParent` 解绑父 signal 与进度回调（父回合 Esc 不再连带停止它）。
   */
  foregroundWaiter?: { resolve(result: SubagentResult): void; detachParent(): void };
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
  /** [W6-C0] 写父会话的 `ama.trace`（外部 Agent 回合骨架）。 */
  appendTrace?(data: TraceExternalTurnData): void;
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
  if (record.info.runner !== "ama") recordDisplay(record, event, sink.now());
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
      if (event.contextTokens !== undefined) record.info.contextTokens = event.contextTokens;
      if (event.contextWindow !== undefined) record.info.contextWindow = event.contextWindow;
      return;
    case "notice":
      sink.log(event.level, `[task ${taskId}] ${event.text}`);
      return;
    case "context":
      record.info.context = event.mode;
      return;
    case "turn_trace":
      sink.appendTrace?.({
        kind: "external_turn",
        taskId,
        agent: record.info.agent,
        ...event.trace,
      });
      return;
    default:
      return;
  }
}

/** [W6-A] 外部 Agent 的进度 → 环形缓冲（ama 子会话由视图直接订阅子会话，不进这里）。 */
function recordDisplay(record: TaskRecord, event: SubagentEvent, now: number): void {
  const turn = record.info.turns ?? 0;
  const ring = (record.ring ??= new DisplayRing());
  switch (event.type) {
    case "text":
    case "thought":
      if (event.delta !== "") ring.push({ at: now, kind: event.type, text: event.delta, turn });
      return;
    case "tool":
      ring.push({
        at: event.at ?? now,
        kind: "tool",
        toolName: event.toolName,
        status: event.status,
        ...(event.id === undefined ? {} : { toolId: event.id }),
        turn,
      });
      return;
    case "turn":
      ring.push({ at: now, kind: "turn", turn: event.turn });
      return;
    case "notice":
      ring.push({ at: now, kind: "notice", text: event.text, level: event.level, turn });
      return;
    default:
      return;
  }
}

/** 任务的上下文占用（0–100，一位小数，封顶 100）；占用或窗口未知时 undefined。 */
export function taskContextPercent(
  info: Pick<TaskInfo, "contextTokens" | "contextWindow">,
): number | undefined {
  const { contextTokens: used, contextWindow: size } = info;
  if (used === undefined || size === undefined || size <= 0) return undefined;
  return Math.min(100, Math.round((used / size) * 1000) / 10);
}

/** 上下文占用的显示：≥ 10% 取整，以下保留一位小数（`34%`、`0.4%`）；未知时 undefined。 */
export function formatTaskContext(
  info: Pick<TaskInfo, "contextTokens" | "contextWindow">,
): string | undefined {
  const percent = taskContextPercent(info);
  if (percent === undefined) return undefined;
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}

/** `subagent_start` 事件（新开或续聊都发）。 */
export function startEvent(record: TaskRecord, handle: TaskHandle): SubagentStartEvent {
  const event: SubagentStartEvent = {
    type: "subagent_start",
    taskId: record.info.taskId,
    parentToolCallId: record.parentToolCallId,
    agent: record.agent.name,
    runner: record.agent.runner,
    description: record.info.description,
    background: record.info.background,
    cwd: record.cwd,
  };
  if (handle.model !== undefined) event.model = handle.model;
  if (handle.sessionFile !== undefined) event.sessionFile = handle.sessionFile;
  return event;
}

/** `getStats().tasks`：没有任务时 undefined。 */
export function taskStats(records: Iterable<TaskRecord>): SessionTaskStats | undefined {
  const byStatus: SessionTaskStats["byStatus"] = {};
  let total = 0;
  let running = 0;
  for (const { info } of records) {
    total++;
    if (info.status === "running") running++;
    else byStatus[info.status] = (byStatus[info.status] ?? 0) + 1;
  }
  return total === 0 ? undefined : { total, running, byStatus };
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
