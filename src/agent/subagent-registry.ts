/**
 * 子 Agent 任务注册表（docs/wave5-plan.md §7.3–§7.6，D13、D23–D24）。[W5-G]
 *
 * 每个根会话一份（按会话 id 登记；compose-agents.ts 的扩展在会话构造时建，SDK / 测试直接构造的
 * 会话在首次 task 时以缺省环境懒建）。职责：
 * - 解析类型（catalog）→ 选 runner：ama 子会话（session-subagent.ts 的工厂）或外部 runner（W5-E /
 *   宿主，经 `env.runners`）；同一 `task(agent=…)` 入口；
 * - 并发池（`subagents.maxConcurrent`，缺省 4）+ 排队上限（`maxPending`，缺省 16，超出报错不要重试）；
 * - 前台（等结果）/ 后台（立即返回 taskId，完成后 `<task-notification>` 走父会话 followUp 队列）；
 * - `taskId` 续聊：句柄保留 16 个（LRU，释放的只是内存，JSONL 永在），被释放或 resume 后按会话
 *   文件 / 外部会话 id 重新接上；
 * - 结果 > 50 KB 保留头尾并全文落 `outputs/`；轮数耗尽加说明；worktree 隔离；
 * - 事件 `subagent_start / update / end`；父会话 `custom{ama.task}` 记任务快照（带 `status`），
 *   resume 时据此重建（未完成标 `interrupted`）。
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
import {
  MAX_TURNS_NOTE,
  capTaskText,
  taskNotification,
  writeTaskOutput,
} from "../agents/result.js";
import {
  SubagentPool,
  TASK_CUSTOM_TYPE,
  applyRunnerEvent,
  flushText,
  newRecord,
  rebuildRecords,
  recordData,
  type AmaRunnerSpec,
  type ProgressSink,
  type TaskHandle,
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

export const DEFAULT_SUBAGENT_CONCURRENCY = 4;
export const DEFAULT_MAX_PENDING = 16;
export const DEFAULT_RETAINED = 16;

export { SubagentPool, TASK_CUSTOM_TYPE, type AmaRunnerSpec, type TaskHandle };
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
}

/** 注册表需要的父会话能力（`SessionCore`；followUp 为 AgentSessionImpl 的公开方法）。 */
export type RegistryHost = Pick<
  SessionCore,
  "manager" | "cwd" | "emit" | "appendEntry" | "outputDir" | "log" | "options"
> & {
  followUp?(text: string, options?: { origin?: string }): Promise<unknown>;
  waitForIdle?(): Promise<void>;
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
  private delivery: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: RegistryHost,
    private readonly env: SubagentEnvironment,
  ) {
    this.catalog = env.catalog;
    this.pool = new SubagentPool(env.maxConcurrent ?? DEFAULT_SUBAGENT_CONCURRENCY);
    const rebuilt = rebuildRecords(host.manager.branch(), this.catalog, host.cwd);
    this.tasks = rebuilt.records;
    this.seq = rebuilt.seq;
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
    if (this.tasks.size === 0) return undefined;
    const byStatus: SessionTaskStats["byStatus"] = {};
    let running = 0;
    for (const { info } of this.tasks.values()) {
      if (info.status === "running") running++;
      else byStatus[info.status] = (byStatus[info.status] ?? 0) + 1;
    }
    return { total: this.tasks.size, running, byStatus };
  }

  /** 运行中任务的已有输出（`task_ctl output`）；结束后为最终文本。 */
  output(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.text;
  }

  /** 等任务结束或超时；超时返回 undefined。 */
  async wait(taskId: string, timeoutMs: number): Promise<SubagentResult | undefined> {
    const record = this.tasks.get(taskId);
    if (record === undefined) throw new AmaError("task_not_found", `unknown task ${taskId}`);
    if (record.running === undefined) return record.last;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    try {
      return await Promise.race([record.running, timeout]);
    } finally {
      clearTimeout(timer);
    }
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
    const background = request.background ?? agent.background;
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
    return this.launch(record, request, ama, request.background ?? false);
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
    const running = this.execute(record, request, ama, controller.signal).finally(() => {
      parentSignal?.removeEventListener("abort", onParentAbort);
      delete record.running;
      delete record.controller;
    });
    record.running = running;
    if (!background) return running;
    void running.then((result) => this.notify(record, result));
    return Promise.resolve(this.startedResult(record));
  }

  private startedResult(record: TaskRecord): SubagentResult {
    const result: SubagentResult = {
      text:
        `Started background task ${record.info.taskId} (agent ${record.agent.name}). ` +
        "A <task-notification> arrives when it finishes; use task_ctl to wait, stop or read output.",
      usage: { ...ZERO_USAGE },
      stopReason: "stop",
      isError: false,
      taskId: record.info.taskId,
      status: "running",
    };
    const file = this.outputFileFor(record.info.taskId);
    if (file !== undefined) result.outputFile = file;
    return result;
  }

  private async execute(
    record: TaskRecord,
    request: SubagentRequest,
    ama: AmaRunnerFactory,
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    try {
      await this.pool.acquire(signal);
    } catch {
      return this.finish(record, { ...failed("aborted by user"), status: "aborted" });
    }
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
    if (live !== undefined) {
      this.touch(record.info.taskId);
      this.emitStart(record, live);
      await live.send(request.prompt);
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
    const event: Extract<Parameters<RegistryHost["emit"]>[0], { type: "subagent_start" }> = {
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
    this.host.emit(event);
  }

  private sink(): ProgressSink {
    return {
      emit: (event) => this.host.emit(event),
      log: (level, message) => this.host.log(level, message),
      now: () => this.now(),
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

  private notify(record: TaskRecord, result: SubagentResult): void {
    // 被停止的任务（task_ctl stop、会话关闭）不再通知：发起停止的一方已经知道
    if (this.disposed || result.status === "aborted") return;
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
    // 父空闲时投递（开新回合）；父正忙则等这一周期结束再投——周期收尾阶段入队的 followUp 会滞留到
    // 下一次提示。串行投递保证按完成顺序到达。
    this.delivery = this.delivery
      .then(async () => {
        await host.waitForIdle?.();
        if (!this.disposed) await followUp.call(host, text, { origin: "task" });
      })
      .catch((error: unknown) => host.log("warn", `task notification failed: ${String(error)}`));
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
