/**
 * 子 Agent 任务注册表（docs/wave5-plan.md §7.3–§7.6，D13、D23–D24）。[W5-G]
 *
 * 每个根会话一份（按会话 id 登记；compose-agents.ts 的扩展在会话构造时建，SDK / 测试直接构造的
 * 会话在首次 task 时以缺省环境懒建）。职责：
 * - 解析类型（catalog）→ 选 runner：ama 子会话（session-subagent.ts 的工厂）或外部 runner（W5-E /
 *   宿主，经 `env.runners`）；同一 `task(agent=…)` 入口；
 * - 并发池（`subagents.maxConcurrent`，缺省 4）+ 排队上限（`maxPending`，缺省 16，超出报错不要重试）；
 * - 前台（等结果）/ 后台（立即返回 taskId，完成后 `<task-notification>` 走父会话 followUp 队列）；
 * - `taskId` 续聊：句柄保留 4 个（`subagents.retainSessions`，LRU，释放的只是内存，JSONL 永在），被释放或 resume 后按会话
 *   文件 / 外部会话 id 重新接上；
 * - 结果 > 50 KB 保留头尾并全文落 `outputs/`；轮数耗尽加说明；worktree 隔离；
 * - 事件 `subagent_start / update / end`；父会话 `custom{ama.task}` 记任务快照（带 `status`），
 *   resume 时据此重建（未完成标 `interrupted`）。
 * - [W6-A] 子 Agent 视图的 `live()` / `message()`（实现在 subagent-direct.ts）。
 * - [W7-B1] 缺省后台、前台转后台 `background()`、通知投递与 `settled()`（subagent-background.ts）。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmaError } from "../errors.js";
import type {
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
  SubagentStatus,
  TaskInfo,
  TaskRegistryView,
} from "../tools/types.js";
import { DEFAULT_AGENT } from "../agents/builtin.js";
import { AgentCatalog, resolveAgentModel, type AgentModelConfig } from "../agents/catalog.js";
import { MAX_TURNS_NOTE, capTaskText, writeTaskOutput } from "../agents/result.js";
import {
  SubagentPool,
  TASK_CUSTOM_TYPE,
  applyRunnerEvent,
  flushText,
  newRecord,
  rebuildRecords,
  recordData,
  startEvent,
  taskStats,
  type AmaRunnerSpec,
  type ProgressSink,
  type TaskHandle,
  type TaskLive,
  type TaskRecord,
} from "../agents/task-record.js";
import {
  registerTaskControl,
  unregisterTaskControl,
  type TaskControl,
} from "../agents/task-control.js";
import type { AgentDefinition, AgentInfo } from "../agents/types.js";
import { ZERO_USAGE } from "./loop.js";
import type { SessionCore } from "./session-core.js";
import type { SessionTaskStats } from "./types.js";
import { createWorktree, finishWorktree } from "./worktree.js";
import { appendTraceEntry } from "./session-trace-writer.js";
import { directMessage, drainDirect, liveOf, type DirectReply } from "./subagent-direct.js";
import {
  TaskNotifier,
  WaitDetach,
  backgroundRecords,
  blockingTasks,
  foregroundWaiter,
  settleTasks,
  startedResult,
  waitForTask,
  type BackgroundReason,
} from "./subagent-background.js";

export const DEFAULT_SUBAGENT_CONCURRENCY = 4;
export const DEFAULT_MAX_PENDING = 16;
export const DEFAULT_RETAINED = 4;

export { SubagentPool, TASK_CUSTOM_TYPE, type AmaRunnerSpec, type TaskHandle };
export type { BackgroundReason };
export type AmaRunnerFactory = (spec: AmaRunnerSpec) => SubagentRunner;

export interface SubagentEnvironment {
  catalog: AgentCatalog;
  maxConcurrent?: number;
  maxPending?: number;
  retain?: number;
  modelConfig?: AgentModelConfig;
  /** 外部 / 宿主 runner（W5-E `ProcessRunner`、HostApi.runners）；没有返回 undefined。 */
  runners?(agent: AgentDefinition): SubagentRunner | undefined;
  now?(): number;
  /** [W7-B1] `task` 未指定 background 且类型也没指定时的缺省（`subagents.background` 解析后）；缺省前台。 */
  background?: boolean;
  /** [W7-B1] 前台任务运行超过该毫秒数自动转后台（`subagents.autoBackgroundAfterMs`）；0 / 不设关闭。 */
  autoBackgroundAfterMs?: number;
}

/** 注册表需要的父会话能力（`SessionCore`；followUp 为 AgentSessionImpl 的公开方法）。 */
export type RegistryHost = Pick<
  SessionCore,
  "manager" | "cwd" | "emit" | "appendEntry" | "outputDir" | "log" | "options"
> & {
  followUp?(text: string, options?: { origin?: string }): Promise<unknown>;
  waitForIdle?(): Promise<void>;
  /** [W6-A] 视图里续聊已结束的任务（AgentSessionImpl 的方法，经 runSubagent 拿到 ama runner 工厂）。 */
  spawnSubagent?(request: SubagentRequest): Promise<SubagentResult>;
};

const registries = new Map<string, SubagentRegistry>();

/** RPC `get_tasks` / `/tasks`：会话 id → 注册表视图（没有任务时 undefined）。 */
export function taskRegistryView(sessionId: string): TaskRegistryView | undefined {
  return registries.get(sessionId);
}

/** RPC `get_agents` / `/agents`：会话可用的类型（没有 task 工具、注册表未装配时为空）。 */
export function sessionAgents(sessionId: string): AgentInfo[] {
  return registries.get(sessionId)?.catalog.infos() ?? [];
}

export function registryOf(sessionId: string): SubagentRegistry | undefined {
  return registries.get(sessionId);
}

/** 取会话的注册表；没有就以 `env`（缺省只有内置类型）新建并登记。 */
export function subagentRegistryFor(
  host: RegistryHost,
  env: SubagentEnvironment = { catalog: new AgentCatalog() },
): SubagentRegistry {
  const existing = registries.get(host.manager.id);
  if (existing !== undefined) return existing;
  const registry = new SubagentRegistry(host, env);
  registries.set(host.manager.id, registry);
  registerTaskControl(host.manager.id, registry);
  return registry;
}

function failed(text: string): SubagentResult {
  return { text, usage: { ...ZERO_USAGE }, stopReason: "error", isError: true, status: "failed" };
}

const TERMINAL: readonly SubagentStatus[] = [
  "completed",
  "failed",
  "aborted",
  "max_turns",
  "interrupted",
];

export class SubagentRegistry implements TaskControl {
  readonly catalog: AgentCatalog;
  private readonly pool: SubagentPool;
  private readonly tasks: Map<string, TaskRecord>;
  private readonly retained: string[] = [];
  private seq = 0;
  private disposed = false;
  private readonly notifier: TaskNotifier;
  private readonly waits = new WaitDetach();

  constructor(
    private readonly host: RegistryHost,
    readonly env: SubagentEnvironment,
  ) {
    this.catalog = env.catalog;
    this.pool = new SubagentPool(env.maxConcurrent ?? DEFAULT_SUBAGENT_CONCURRENCY);
    const rebuilt = rebuildRecords(host.manager.branch(), this.catalog, host.cwd);
    this.tasks = rebuilt.records;
    this.seq = rebuilt.seq;
    this.notifier = new TaskNotifier(host, () => this.disposed);
  }

  private now(): number {
    return this.env.now?.() ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  list(): readonly TaskInfo[] {
    return [...this.tasks.values()].map((record) => ({ ...record.info }));
  }

  get(taskId: string): TaskInfo | undefined {
    const record = this.tasks.get(taskId);
    return record === undefined ? undefined : { ...record.info };
  }

  stats(): SessionTaskStats | undefined {
    return taskStats(this.tasks.values());
  }

  /** 运行中任务的已有输出（`task_ctl output`）；结束后为最终文本。 */
  output(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.text;
  }

  /** 等结束；超时或 signal（缺省本任务的转后台信号，`background()` 触发）返回 undefined。[W7-B1] */
  async wait(
    taskId: string,
    timeoutMs: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<SubagentResult | undefined> {
    const record = this.tasks.get(taskId);
    if (record === undefined) throw new AmaError("task_not_found", `unknown task ${taskId}`);
    return waitForTask(record, timeoutMs, options.signal ?? this.waits.signal(taskId), this.waits);
  }

  /** [W7-B1] `task_ctl wait` 用的打断信号（`background()` 触发后换新）。 */
  detachSignal(taskId: string): AbortSignal {
    return this.waits.signal(taskId);
  }

  /** [W7-B1] 正在阻塞父回合的任务：运行中的前台任务与有 `task_ctl wait` 在等的任务。 */
  blocking(): string[] {
    return blockingTasks(this.tasks.values(), this.waits);
  }

  /**
   * [W7-B1] 前台任务转后台（§2.5，subagent-background.ts），并打断等它的 `task_ctl wait`；不给 taskId =
   * 全部。返回被转后台或被打断等待的 taskId（不在运行时为空）。
   */
  background(taskId?: string, reason: BackgroundReason = "user"): string[] {
    if (this.disposed) return [];
    const one = taskId === undefined ? undefined : this.tasks.get(taskId);
    const records =
      taskId === undefined ? [...this.tasks.values()] : one === undefined ? [] : [one];
    const moved = backgroundRecords(records, reason, {
      emit: (event) => this.host.emit(event),
      persist: (record) => this.persist(record),
      notify: (record, result) => this.notifier.notify(record, result),
      afterMs: this.env.autoBackgroundAfterMs ?? 0,
      outputFile: (id) => this.outputFileFor(id),
    });
    return [...new Set([...moved, ...this.waits.detach(taskId)])];
  }

  /** [W7-B1] `-p` 收尾：等到没有运行中的任务、通知回合也已跑完；会话关闭立即返回。 */
  settled(): Promise<void> {
    return settleTasks(this.tasks, this.notifier, () => this.disposed);
  }

  /** [W6-A] 子 Agent 视图读的实时数据；未知任务 undefined。 */
  live(taskId: string): TaskLive | undefined {
    const record = this.tasks.get(taskId);
    return record === undefined ? undefined : liveOf(record);
  }

  /** [W6-A] 人在子 Agent 视图里发的消息（subagent-direct.ts）。 */
  async message(taskId: string, text: string, interrupt = false): Promise<DirectReply> {
    const record = this.tasks.get(taskId);
    if (record === undefined) throw new AmaError("task_not_found", `unknown task ${taskId}`);
    return directMessage(record, text, this.host, interrupt);
  }

  async stop(taskId: string): Promise<SubagentResult | undefined> {
    const record = this.tasks.get(taskId);
    if (record === undefined) throw new AmaError("task_not_found", `unknown task ${taskId}`);
    if (record.running === undefined) return record.last;
    record.controller?.abort();
    return record.running;
  }

  // -------------------------------------------------------------------------
  // 运行
  // -------------------------------------------------------------------------

  async run(request: SubagentRequest, ama: AmaRunnerFactory): Promise<SubagentResult> {
    if (this.disposed) return failed("the session is closed");
    if (request.taskId !== undefined) return this.continueTask(request, ama);
    const name = request.agent ?? DEFAULT_AGENT;
    const agent = this.catalog.get(name);
    if (agent === undefined)
      return failed(`Unknown agent "${name}". Available: ${this.catalog.names().join(", ")}.`);
    if (agent.runner !== "ama" && this.env.runners?.(agent) === undefined)
      return failed(`External agent "${name}" (${agent.runner}) is not available here.`);
    const queued = this.pool.waiting;
    if (queued >= (this.env.maxPending ?? DEFAULT_MAX_PENDING))
      return failed(
        `Too many sub-agent tasks are queued (${queued}). Do not retry; wait for running tasks first (task_ctl wait).`,
      );
    const model = resolveAgentModel(agent, request.model, this.env.modelConfig ?? {});
    if (model.warning !== undefined) this.host.log("warn", `agent ${name}: ${model.warning}`);
    const background = request.background ?? agent.background ?? this.env.background ?? false;
    const taskId = `t${++this.seq}`;
    const record = newRecord(
      {
        taskId,
        agent: agent.name,
        runner: agent.runner,
        description: request.description ?? "",
        background,
        status: "running",
        startedAt: this.now(),
      },
      agent,
      request.parentToolCallId,
      this.host.cwd,
      request.isolation ?? agent.isolation,
    );
    if (model.ref !== undefined) record.modelRef = model.ref;
    this.tasks.set(taskId, record);
    return this.launch(record, request, ama, background);
  }

  private continueTask(request: SubagentRequest, ama: AmaRunnerFactory): Promise<SubagentResult> {
    const taskId = request.taskId as string;
    const record = this.tasks.get(taskId);
    if (record === undefined) return Promise.resolve(failed(`Unknown task ${taskId}.`));
    if (record.running !== undefined)
      return Promise.resolve(
        failed(`Task ${taskId} is still running; use task_ctl wait or stop first.`),
      );
    const ref = record.info.sessionRef;
    const resumable =
      record.agent.runner === "ama" ? ref?.sessionFile !== undefined : ref !== undefined;
    if (record.handle === undefined && !resumable)
      return Promise.resolve(
        failed(`Task ${taskId} cannot be continued (its session was not saved).`),
      );
    const background = request.background ?? record.agent.background ?? this.env.background;
    return this.launch(record, request, ama, background ?? false);
  }

  private launch(
    record: TaskRecord,
    request: SubagentRequest,
    ama: AmaRunnerFactory,
    background: boolean,
  ): Promise<SubagentResult> {
    const controller = new AbortController();
    record.controller = controller;
    record.info.status = "running";
    record.info.background = background;
    delete record.info.endedAt;
    record.text = "";
    if (background) delete record.onUpdate;
    else if (request.onUpdate !== undefined) record.onUpdate = request.onUpdate;
    const parentSignal = background ? undefined : request.signal;
    const onParentAbort = (): void => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    this.persist(record);
    let timer: NodeJS.Timeout | undefined;
    const running = this.execute(record, request, ama, controller.signal).finally(() => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      delete record.foregroundWaiter;
      delete record.running;
      delete record.controller;
      if (!this.disposed) drainDirect(record, this.host);
    });
    record.running = running;
    const file = this.outputFileFor(record.info.taskId);
    if (background) {
      void running.then((result) => this.notifier.notify(record, result));
      return Promise.resolve(startedResult(record, file));
    }
    // [W7-B1] 前台：转后台（background()）时等待者先行 resolve，工具调用立即返回
    const { waiter, promise } = foregroundWaiter(() => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      delete record.onUpdate;
    });
    record.foregroundWaiter = waiter;
    const after = this.env.autoBackgroundAfterMs ?? 0;
    if (after > 0) {
      timer = setTimeout(() => this.background(record.info.taskId, "timeout"), after);
      timer.unref?.();
    }
    return Promise.race([running, promise]);
  }

  private async execute(
    record: TaskRecord,
    request: SubagentRequest,
    ama: AmaRunnerFactory,
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    record.queued = true;
    try {
      await this.pool.acquire(signal);
    } catch {
      delete record.queued;
      return this.finish(record, { ...failed("aborted by user"), status: "aborted" });
    }
    delete record.queued;
    try {
      if (record.isolation === "worktree" && record.worktree === undefined) {
        // 名字带会话 id 前缀：不同会话的 t1 不会撞到同一个 worktree / 分支
        const name = `${this.host.manager.id.slice(0, 8)}-${record.info.taskId}`;
        record.worktree = await createWorktree(this.host.cwd, name);
        record.cwd = record.worktree.cwd;
      }
      const handle = await this.handleFor(record, request, ama, signal);
      const onAbort = (): void => void handle.stop().catch(() => undefined);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        return this.finish(record, await handle.wait(), signal.aborted);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.finish(record, failed(`Sub-agent failed: ${message}`), signal.aborted);
    } finally {
      this.pool.release();
    }
  }

  private async handleFor(
    record: TaskRecord,
    request: SubagentRequest,
    ama: AmaRunnerFactory,
    signal: AbortSignal,
  ): Promise<TaskHandle> {
    const live = record.handle;
    const direct = record.directNext === true;
    delete record.directNext;
    if (live !== undefined) {
      this.touch(record.info.taskId);
      this.emitStart(record, live);
      if (direct && live.message !== undefined) await live.message(request.prompt, "send");
      else await live.send(request.prompt);
      return live;
    }
    const ref = record.info.sessionRef;
    const runner =
      record.agent.runner === "ama"
        ? ama({
            taskId: record.info.taskId,
            agent: record.agent,
            request,
            ...(record.modelRef === undefined ? {} : { modelRef: record.modelRef }),
            cwd: record.cwd,
            ...(ref?.sessionFile === undefined ? {} : { resumeFile: ref.sessionFile }),
            isolated: record.worktree !== undefined,
            ...(direct ? { origin: "direct" } : {}),
          })
        : this.env.runners?.(record.agent);
    if (runner === undefined) throw new Error(`runner ${record.agent.runner} is not available`);
    const handle: TaskHandle = await runner.start({
      prompt: request.prompt,
      cwd: record.cwd,
      mode: this.host.options.permission?.mode ?? "default",
      ...(record.modelRef === undefined ? {} : { model: record.modelRef }),
      ...(ref !== undefined && record.agent.runner !== "ama" ? { resume: ref.sessionId } : {}),
      ...(request.budgetUsd === undefined ? {} : { budgetUsd: request.budgetUsd }),
      taskId: record.info.taskId,
      signal,
      onEvent: (event) => applyRunnerEvent(record, event, this.sink()),
    });
    record.handle = handle;
    record.info.sessionRef = {
      runner: record.agent.runner,
      sessionId: handle.id,
      ...(handle.sessionFile === undefined ? {} : { sessionFile: handle.sessionFile }),
    };
    this.emitStart(record, handle);
    return handle;
  }

  private emitStart(record: TaskRecord, handle: TaskHandle): void {
    this.host.emit(startEvent(record, handle));
  }

  private sink(): ProgressSink {
    return {
      emit: (event) => this.host.emit(event),
      log: (level, message) => this.host.log(level, message),
      now: () => this.now(),
      appendTrace: (data) => appendTraceEntry(this.host, data), // [W6-C0]
    };
  }

  private async finish(
    record: TaskRecord,
    result: SubagentResult,
    aborted = false,
  ): Promise<SubagentResult> {
    flushText(record, this.sink());
    const status: SubagentStatus = aborted
      ? "aborted"
      : result.status !== undefined && TERMINAL.includes(result.status as SubagentStatus)
        ? (result.status as SubagentStatus)
        : result.isError
          ? "failed"
          : "completed";
    if (record.worktree !== undefined) {
      try {
        record.worktreeOutcome = await finishWorktree(record.worktree);
        if (!record.worktreeOutcome.changed) delete record.worktree;
      } catch (error) {
        this.host.log("warn", `worktree cleanup failed: ${String(error)}`);
      }
    }
    const info = record.info;
    info.status = status;
    info.endedAt = this.now();
    if (result.usage.totalTokens > 0 || info.usage === undefined) info.usage = result.usage;
    record.text = result.text;
    let outputFile: string | undefined;
    const full = result.text;
    const capped = capTaskText(full, this.outputFileFor(info.taskId));
    if (capped.truncated || info.background) {
      outputFile = writeTaskOutput(this.outputDirectory(), this.outputName(info.taskId), full);
      if (outputFile !== undefined) info.outputFile = outputFile;
    }
    let text = capped.text.trim() === "" ? "(the sub-agent returned no text)" : capped.text;
    if (status === "max_turns") text = `${MAX_TURNS_NOTE}\n\n${text}`;
    const outcome = record.worktreeOutcome;
    if (outcome?.changed === true)
      text += `\n\n[worktree kept: branch ${outcome.branch} at ${outcome.path ?? "?"}]\n${outcome.diffStat ?? ""}`;
    const final: SubagentResult = {
      ...result,
      text,
      taskId: info.taskId,
      status,
      isError: status === "failed" || status === "aborted",
    };
    if (outputFile !== undefined) final.outputFile = outputFile;
    if (info.sessionRef !== undefined) final.sessionRef = info.sessionRef;
    record.last = final;
    this.persist(record);
    const end: Extract<Parameters<RegistryHost["emit"]>[0], { type: "subagent_end" }> = {
      type: "subagent_end",
      taskId: info.taskId,
      status,
    };
    if (info.usage !== undefined) end.usage = info.usage;
    if (result.cache !== undefined) end.cache = result.cache;
    if (outputFile !== undefined) end.outputFile = outputFile;
    if (outcome !== undefined) end.worktree = { branch: outcome.branch, changed: outcome.changed };
    this.host.emit(end);
    this.retain(info.taskId);
    return final;
  }

  // -------------------------------------------------------------------------
  // 落盘、保留与重建
  // -------------------------------------------------------------------------

  private outputDirectory(): string {
    return this.host.outputDir() ?? join(tmpdir(), "ama-outputs");
  }

  private outputName(taskId: string): string {
    return `${this.host.manager.id}-${taskId}.md`;
  }

  private outputFileFor(taskId: string): string | undefined {
    return join(this.outputDirectory(), this.outputName(taskId));
  }

  private persist(record: TaskRecord): void {
    if (this.disposed) return;
    try {
      this.host.appendEntry({
        type: "custom",
        customType: TASK_CUSTOM_TYPE,
        data: recordData(record),
      });
    } catch (error) {
      this.host.log("warn", `could not record task ${record.info.taskId}: ${String(error)}`);
    }
  }

  private touch(taskId: string): void {
    const at = this.retained.indexOf(taskId);
    if (at >= 0) this.retained.splice(at, 1);
  }

  /** 句柄 LRU：超出上限时释放最久未用、空闲的子会话（JSONL 仍在，续聊时重开）。 */
  private retain(taskId: string): void {
    this.touch(taskId);
    if (this.tasks.get(taskId)?.handle === undefined) return;
    this.retained.push(taskId);
    const limit = this.env.retain ?? DEFAULT_RETAINED;
    while (this.retained.length > limit) {
      const evicted = this.tasks.get(this.retained.shift() as string);
      const handle = evicted?.handle;
      if (evicted === undefined || handle === undefined) continue;
      delete evicted.handle;
      void (handle.dispose?.() ?? handle.stop()).catch(() => undefined);
    }
  }

  /** 会话关闭：停止运行中的任务、释放保留的子会话。 */
  dispose(): void {
    if (this.disposed) return;
    for (const record of this.tasks.values()) {
      record.controller?.abort();
      const handle = record.handle;
      delete record.handle;
      if (handle !== undefined) void (handle.dispose?.() ?? handle.stop()).catch(() => undefined);
    }
    this.disposed = true;
    if (registries.get(this.host.manager.id) === this) registries.delete(this.host.manager.id);
    unregisterTaskControl(this.host.manager.id, this);
  }
}
