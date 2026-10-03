/**
 * AgentSessionImpl（设计 §4.2–§4.3、§9、§11.1 第 16 步、§13.1）。[B2]
 *
 * 会话 = SessionManager（JSONL 树，事实来源）+ Agent（上下文、队列、run）+ 压缩 / 重试 / Hook / 回滚调度。
 * 每条 message_end 落盘；首次请求前落 system + 工具表并 flush。`prompt()` 运行中且无
 * streamingBehavior → busy；`steer / followUp` 运行中入队、空闲时直接开周期；`abort()` 不清队列。
 * [W5-C0] 设置类方法在 session-settings.ts；扩展点（session-extensions.ts）的调用点：构造时
 * wrapStream、emit 后 onEvent、runPrompt 的 beforePrompts、agent_settled 后 onAgentSettled、
 * getStats 末尾 contributeStats、dispose。
 */

import { join } from "node:path";
import type { Model, ModelThinkingLevel, UserMessage } from "../ai/types.js";
import { AmaError } from "../errors.js";
import type { HookEvent, HookEventPayload, HookOutcome } from "../hooks/types.js";
import type { PermissionClassifier } from "../permissions/classifier.js";
import type { PermissionMode } from "../permissions/types.js";
import { createSessionClassifier } from "./session-classifier.js";
import type { SessionManager } from "../session/manager.js";
import { buildProjection } from "../session/projection.js";
import type {
  AgentMessage,
  BranchSummaryEntry,
  SessionEntry,
  SessionEntryInput,
} from "../session/types.js";
import type { SubagentRequest, SubagentResult, ToolDefinition } from "../tools/types.js";
import { Agent } from "./agent.js";
import type { StreamFn } from "./loop.js";
import { queuedText } from "./queue.js";
import { resolveRetrySettings } from "./retry.js";
import type { AgentSessionOptions, SessionCore } from "./session-core.js";
import { SessionCacheController, resolveCacheSettings } from "./session-cache.js";
import { CompactionController } from "./session-compaction.js";
import { makeUserMessage, normalizeOrigin, runPrompt, type RunCycleDeps } from "./session-run.js";
import { buildSessionState, computeStats, lastAssistantText } from "./session-state.js";
import { DEFAULT_SUBAGENT_CONCURRENCY, SubagentPool, runSubagent } from "./session-subagent.js";
import { registryOf, type BackgroundReason } from "./subagent-registry.js";
import { persistMessage, runHookWithEvents, syncSystemMessage } from "./session-sync.js";
import { SessionExtensions } from "./session-extensions.js";
import { SessionSettings, providerStream, type StaticSystemInput } from "./session-settings.js";
import { createToolRunnerOptions } from "./session-tools.js";
import { RewindController, type RewindDraft, type SummarizeFromResult } from "./session-rewind.js";
import type * as CP from "../checkpoints/types.js";
import { convertToLlm } from "./transform.js";
import type {
  AgentSession,
  CompactionResult,
  EnqueueOptions,
  PromptDisposition,
  PromptOptions,
  RetrySettings,
  SessionEvent,
  SessionState,
  SessionStats,
} from "./types.js";
import type { QuotaUpdateEvent } from "./types-w6.js";

export type { AgentSessionOptions } from "./session-core.js";

type Cycle = { controller: AbortController; promise: Promise<void> };

export class AgentSessionImpl implements AgentSession, SessionCore {
  readonly options: AgentSessionOptions;
  readonly manager: SessionManager;
  readonly agent: Agent;
  readonly cwd: string;
  readonly depth: number;
  readonly readFiles = new Set<string>();
  readonly stream: StreamFn;
  readonly cache: SessionCacheController;
  private readonly settings: SessionSettings;
  private readonly extensions: SessionExtensions;
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly compaction: CompactionController;
  private retrySettings: RetrySettings;
  private cycle: Cycle | undefined;
  private retrying = false;
  private stopReason: string | undefined;
  private stopFlag = false;
  private turns = 0;
  private readonly subagentPool: SubagentPool;
  private disposed = false;
  /** [W6-O] 最近一次订阅配额（`quota_update`）。 */
  private lastQuota: QuotaUpdateEvent | undefined;
  private classifier: PermissionClassifier | undefined;
  /** 已入队、尚未投递的消息（投递时发 queue_update）。 */
  private readonly queuedMessages = new WeakSet<object>();
  private readonly rewinder: RewindController;

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.manager = options.sessionManager;
    this.cwd = this.manager.cwd;
    this.depth = options.depth ?? 0;
    this.settings = new SessionSettings(options, {
      core: this,
      assertUsable: () => this.assertUsable(),
      onModelChanged: () => this.compaction.refresh(),
    });
    this.extensions = new SessionExtensions(this, options.extensions);
    this.retrySettings = resolveRetrySettings(options.retry);
    this.cache = new SessionCacheController(this, resolveCacheSettings(options.cache), {
      decider: () => options.warmingDecider?.(),
    });
    // 缓存控制器在最外层（看到扩展改写后的最终请求）
    this.stream = this.cache.wrapStream(
      this.extensions.wrapStream(providerStream(options.providers)),
    );
    const runner = createToolRunnerOptions(this);
    const agentOptions: ConstructorParameters<typeof Agent>[0] = {
      hooks: {
        convertToLlm: (messages) =>
          convertToLlm(messages, {
            provider: this.settings.model.provider,
            model: this.settings.model.id,
          }),
        beforeToolCall: runner.beforeToolCall,
        prepareNextTurn: async () => {
          const signal = this.agent.signal ?? this.cycle?.controller.signal;
          if (signal !== undefined) await this.compaction.checkThreshold(signal);
        },
        finishTurn: async () => {
          this.turns++;
          if (this.stopFlag) return "end";
          const maxTurns = options.maxTurns;
          return maxTurns !== undefined && this.turns >= maxTurns ? "end" : "continue";
        },
      },
      stream: this.stream,
      getModel: () => this.settings.model,
      getThinkingLevel: () => this.settings.thinking,
      streamOptions: async () => {
        const apiKey = await this.resolveApiKey();
        const idle = options.idleTimeoutMs;
        return {
          sessionId: this.manager.id,
          // [W6-O] ChatGPT 订阅配额 → quota_update 事件（/session 显示最近一次）
          onQuota: (update) => {
            this.lastQuota = {
              type: "quota_update",
              provider: this.settings.model.provider,
              ...update,
            };
            this.emit(this.lastQuota);
          },
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(idle === undefined ? {} : { idleTimeoutMs: idle }),
        };
      },
      beforeRequest: async () => {
        this.syncSystem();
        this.manager.flush();
        await this.rewinder.ready();
      },
      tools: runner,
      messages: buildProjection(this.manager.branch()).messages,
      onListenerError: (error, event) =>
        this.log("warn", `listener failed on ${event.type}: ${String(error)}`),
    };
    if (options.steeringMode !== undefined) agentOptions.steeringMode = options.steeringMode;
    if (options.followUpMode !== undefined) agentOptions.followUpMode = options.followUpMode;
    this.agent = new Agent(agentOptions);
    this.agent.subscribe((event) => this.onAgentEvent(event));
    this.compaction = new CompactionController(this, options.compaction);
    const subagents = options.subagents === false ? undefined : options.subagents;
    this.subagentPool = new SubagentPool(subagents?.maxConcurrent ?? DEFAULT_SUBAGENT_CONCURRENCY);
    this.rewinder = new RewindController({
      core: this,
      running: () => {
        this.assertUsable();
        return this.cycle !== undefined;
      },
      navigate: (targetId, navigateOptions) => this.navigate(targetId, navigateOptions),
      compactAt: (entryId, instructions) => this.compact(instructions, entryId),
    });
  }

  // -------------------------------------------------------------------------
  // SessionCore
  // -------------------------------------------------------------------------

  model(): Model {
    return this.settings.model;
  }

  thinkingLevel(): ModelThinkingLevel {
    return this.settings.thinking;
  }

  outputDir(): string | undefined {
    if (this.options.outputDir !== undefined) return this.options.outputDir;
    const dir = this.manager.directory();
    return dir === undefined ? undefined : join(dir, "outputs");
  }

  async resolveApiKey(): Promise<string | undefined> {
    try {
      const { provider, channel } = this.settings.model;
      return (await this.options.providers.resolveApiKey(provider, channel)).apiKey;
    } catch {
      return undefined;
    }
  }

  emit(event: SessionEvent): void {
    this.cache.onEvent(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log("warn", `session listener failed on ${event.type}: ${String(error)}`);
      }
    }
    this.extensions.onEvent(event);
  }

  appendEntry(input: SessionEntryInput): SessionEntry {
    const entry = this.manager.append(input);
    this.emit({ type: "entry_appended", entry });
    return entry;
  }

  reloadMessages(): void {
    this.agent.messages = buildProjection(this.manager.branch()).messages;
  }

  activeTool(name: string): ToolDefinition | undefined {
    return this.settings.activeTool(name);
  }

  tool(name: string): ToolDefinition | undefined {
    return this.settings.tool(name);
  }

  activeToolNames(): string[] {
    return this.settings.activeToolNames();
  }

  runHook(
    event: HookEvent,
    payload: HookEventPayload,
    signal?: AbortSignal,
  ): Promise<HookOutcome | undefined> {
    return runHookWithEvents(this, event, payload, signal);
  }

  requestStop(reason: string | undefined): void {
    this.stopFlag = true;
    this.stopReason = reason;
  }

  log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, message);
  }

  // -------------------------------------------------------------------------
  // 事件与落盘
  // -------------------------------------------------------------------------

  private onAgentEvent(event: SessionEvent): void {
    if (event.type === "message_end")
      this.rewinder.onPersisted(persistMessage(this, event.message));
    else if (event.type === "agent_start") this.compaction.breaker.startRun();
    this.emit(event);
    if (
      event.type === "message_start" &&
      event.message.role === "user" &&
      this.queuedMessages.delete(event.message)
    ) {
      this.emitQueue();
    }
  }

  private emitQueue(): void {
    this.emit({
      type: "queue_update",
      steering: this.agent.steeringQueue.snapshot().map(queuedText),
      followUp: this.agent.followUpQueue.snapshot().map(queuedText),
    });
  }

  private syncSystem(): void {
    syncSystemMessage(this, this.settings.systemInput, this.getTools());
  }

  // -------------------------------------------------------------------------
  // 周期
  // -------------------------------------------------------------------------

  private assertUsable(): void {
    if (this.disposed) throw new AmaError("session_closed", "session is disposed");
  }

  private startCycle<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let done: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.cycle = { controller, promise };
    this.turns = 0;
    this.stopFlag = false;
    this.stopReason = undefined;
    return (async () => {
      try {
        return await work(controller.signal);
      } finally {
        this.cycle = undefined;
        this.retrying = false;
        done();
      }
    })();
  }

  private runDeps(): RunCycleDeps {
    return {
      core: this,
      compaction: this.compaction,
      retry: () => this.retrySettings,
      syncSystem: () => this.syncSystem(),
      stopRequested: () => this.stopFlag,
      setRetrying: (value) => {
        this.retrying = value;
      },
      lastAssistantText: () => this.getLastAssistantText(),
      beginTurn: (message) => this.rewinder.beginTurn(message),
      beforePrompts: (prompts) => this.extensions.beforePrompts(prompts),
      afterSettled: () => this.extensions.onAgentSettled(),
    };
  }

  // -------------------------------------------------------------------------
  // AgentSession
  // -------------------------------------------------------------------------

  async prompt(text: string, options: PromptOptions = {}): Promise<PromptDisposition> {
    this.assertUsable();
    if (this.cycle !== undefined) {
      const behavior = options.streamingBehavior;
      if (behavior === undefined) {
        throw new AmaError(
          "busy",
          "a run is in progress; pass streamingBehavior or use steer()/followUp()",
        );
      }
      this.enqueue(
        makeUserMessage(text, options.images, normalizeOrigin(options.origin ?? behavior)),
        behavior,
      );
      return "queued";
    }
    const origin = normalizeOrigin(options.origin);
    return this.startCycle((signal) =>
      runPrompt(this.runDeps(), text, options.images, origin, signal),
    );
  }

  private enqueue(message: UserMessage, queue: "steer" | "followUp"): void {
    this.queuedMessages.add(message);
    if (queue === "steer") this.agent.steer(message);
    else this.agent.followUp(message);
    this.emitQueue();
  }

  private async enqueueOrRun(
    text: string,
    queue: "steer" | "followUp",
    options: EnqueueOptions,
  ): Promise<"queued" | "handled"> {
    this.assertUsable();
    const origin = normalizeOrigin(options.origin ?? queue);
    if (this.cycle === undefined) {
      await this.startCycle((signal) => runPrompt(this.runDeps(), text, undefined, origin, signal));
      return "handled";
    }
    this.enqueue(makeUserMessage(text, undefined, origin), queue);
    return "queued";
  }

  steer(text: string, options: EnqueueOptions = {}): Promise<"queued" | "handled"> {
    return this.enqueueOrRun(text, "steer", options);
  }

  followUp(text: string, options: EnqueueOptions = {}): Promise<"queued" | "handled"> {
    return this.enqueueOrRun(text, "followUp", options);
  }

  async abort(): Promise<void> {
    const cycle = this.cycle;
    if (cycle === undefined) return;
    cycle.controller.abort();
    this.agent.abort();
    await cycle.promise;
  }

  waitForIdle(): Promise<void> {
    return this.cycle?.promise ?? Promise.resolve();
  }

  /**
   * [W7-B1] 把阻塞中的前台子 Agent 任务转后台（不给 taskId = 全部）：工具调用立即返回，任务继续，完成后
   * 照常 `<task-notification>`。返回被转后台（或被打断等待）的 taskId。
   */
  backgroundTask(taskId?: string, reason: BackgroundReason = "host"): string[] {
    return registryOf(this.manager.id)?.background(taskId, reason) ?? [];
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const cleared = {
      steering: this.agent.steeringQueue.clear().map(queuedText),
      followUp: this.agent.followUpQueue.clear().map(queuedText),
    };
    this.emitQueue();
    return cleared;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 手动压缩；运行中 → busy。`cutAt`：以该条目为切点（「摘要到这里」）。 */
  compact(instructions?: string, cutAt?: string): Promise<CompactionResult> {
    this.assertUsable();
    if (this.cycle !== undefined)
      return Promise.reject(new AmaError("busy", "cannot compact while running"));
    return this.startCycle((signal) => this.compaction.compactManual(instructions, signal, cutAt));
  }

  // [RW-B] 回滚（docs/rewind-plan.md §3；编排与校验在 session-rewind.ts）
  readonly rewindPoints = (): CP.RewindPoint[] => this.rewinder.points();
  readonly rewind = (request: CP.RewindRequest): Promise<CP.RewindResult> =>
    this.rewinder.rewind(request);
  readonly summarizeFrom = (entryId: string, instructions?: string): Promise<SummarizeFromResult> =>
    this.rewinder.summarizeFrom(entryId, instructions);
  readonly summarizeUpTo = (entryId: string, instructions?: string): Promise<CompactionResult> =>
    this.rewinder.summarizeUpTo(entryId, instructions);
  readonly canUndoAbortedTurn = (): boolean => this.rewinder.canUndoAbortedTurn();
  readonly undoAbortedTurn = (): Promise<RewindDraft | undefined> =>
    this.rewinder.undoAbortedTurn();
  readonly checkpointHooks = (): CP.CheckpointHooks | undefined => this.rewinder.hooks();

  async fork(entryId: string): Promise<AgentSessionImpl> {
    this.assertUsable();
    if (this.cycle !== undefined) throw new AmaError("busy", "cannot fork while running");
    return new AgentSessionImpl({
      ...this.options,
      ...this.childBase(),
      sessionManager: this.manager.fork(entryId),
    });
  }

  /** `/tree`：同文件换叶子；`summarize` 时为离开的分支写 branch_summary（挂在新叶子下）。 */
  async navigate(
    targetId: string | null,
    options: { summarize?: boolean; instructions?: string } = {},
  ): Promise<BranchSummaryEntry | undefined> {
    this.assertUsable();
    if (this.cycle !== undefined) throw new AmaError("busy", "cannot navigate while running");
    let entry: BranchSummaryEntry | undefined;
    if (options.summarize === true) {
      entry = await this.startCycle((signal) =>
        this.compaction.leaveBranch(targetId, options.instructions, signal),
      );
    } else this.manager.setLeaf(targetId);
    this.reloadMessages();
    this.cache.onContextChanged();
    return entry;
  }

  // [W5-C0] 设置类（session-settings.ts）
  readonly setModel = (ref: string): Promise<void> => this.settings.setModel(ref);
  readonly setThinkingLevel = (level: ModelThinkingLevel): void =>
    this.settings.setThinkingLevel(level);
  readonly setPermissionMode = (mode: PermissionMode): void =>
    this.settings.setPermissionMode(mode);
  readonly setActiveTools = (names: string[]): void => this.settings.setActiveTools(names);
  /** 宿主 / SDK 在会话创建后追加工具（下次请求前以 system 补丁声明）。 */
  readonly addTool = (tool: ToolDefinition, active = true): void =>
    this.settings.addTool(tool, active);
  readonly updateSystem = (patch: Partial<StaticSystemInput>): void =>
    this.settings.updateSystem(patch);
  readonly getTools = (): readonly ToolDefinition[] => this.settings.getTools();
  readonly announceStart = (reason: "startup" | "resume" | "new" | "fork"): void =>
    this.settings.announceStart(reason);

  setAutoCompaction(enabled: boolean): void {
    this.compaction.setAuto(enabled);
  }

  setAutoRetry(enabled: boolean): void {
    this.retrySettings = { ...this.retrySettings, enabled };
  }

  get state(): SessionState {
    return buildSessionState({
      agent: this.agent,
      manager: this.manager,
      model: this.settings.model,
      thinkingLevel: this.settings.thinking,
      permissionMode: this.options.permission?.mode ?? "default",
      isCompacting: this.compaction.isCompacting,
      isRetrying: this.retrying,
      autoCompaction: this.compaction.settings.enabled,
      autoRetry: this.retrySettings.enabled,
    });
  }

  get messages(): readonly AgentMessage[] {
    return this.agent.messages;
  }

  get entries(): readonly SessionEntry[] {
    return this.manager.entries();
  }

  /** run 被 Hook 的 continue:false 结束时的说明。 */
  get stopHookReason(): string | undefined {
    return this.stopReason;
  }

  getLastAssistantText(): string | null {
    return lastAssistantText(this.manager.branch());
  }

  getStats(): SessionStats {
    const contextTokens = this.compaction.estimate().tokens;
    const contextWindow = this.settings.model.contextWindow;
    const stats = computeStats({
      sessionId: this.manager.id,
      sessionFile: this.manager.file(),
      branch: this.manager.branch(),
      contextTokens,
      contextWindow,
      cache: this.cache.stats({ tokens: contextTokens, window: contextWindow }),
      quota: this.lastQuota,
    });
    return this.extensions.contributeStats(stats);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.abort();
    this.cache.dispose();
    this.extensions.dispose();
    this.disposed = true;
    this.manager.close();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // 子 Agent（ToolContext.spawnSubagent，供 B3 的 task 工具）
  // -------------------------------------------------------------------------

  childBase(): Pick<AgentSessionOptions, "model" | "thinkingLevel" | "activeTools" | "system"> {
    return {
      model: this.settings.model,
      thinkingLevel: this.settings.thinking,
      activeTools: this.settings.activeNamesRef(),
      system: this.settings.systemInput,
    };
  }

  autoClassifier(): PermissionClassifier {
    this.classifier ??= createSessionClassifier(this);
    return this.classifier;
  }

  spawnSubagent(request: SubagentRequest): Promise<SubagentResult> {
    return runSubagent(
      this,
      request,
      this.subagentPool,
      (options) => new AgentSessionImpl(options),
    );
  }
}
