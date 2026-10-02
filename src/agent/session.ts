/**
 * AgentSessionImpl（设计 §4.2–§4.3、§9、§11.1 第 16 步、§13.1）。[B2]
 *
 * 会话 = SessionManager（JSONL 树，事实来源）+ Agent（上下文、队列、run）+ 压缩 / 重试 / Hook / 回滚调度。
 * 每条 message_end 落盘；首次请求前落 system + 工具表并 flush。`prompt()` 运行中且无
 * streamingBehavior → busy；`steer / followUp` 运行中入队、空闲时直接开周期；`abort()` 不清队列。
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
import {
  appendModelChange,
  findModelOrThrow,
  persistMessage,
  runHookWithEvents,
  sessionStartEvent,
  syncSystemMessage,
} from "./session-sync.js";
import { createToolRunnerOptions } from "./session-tools.js";
import { RewindController, type RewindDraft, type SummarizeFromResult } from "./session-rewind.js";
import type * as CP from "../checkpoints/types.js";
import type { SystemPromptInput } from "./system-prompt.js";
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
  private currentModel: Model;
  private currentThinking: ModelThinkingLevel;
  private readonly allTools = new Map<string, ToolDefinition>();
  private activeNames: string[];
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly compaction: CompactionController;
  private retrySettings: RetrySettings;
  private cycle: Cycle | undefined;
  private retrying = false;
  private stopReason: string | undefined;
  private stopFlag = false;
  private turns = 0;
  private systemInput: Omit<SystemPromptInput, "tools" | "cwd">;
  private readonly subagentPool: SubagentPool;
  private disposed = false;
  private classifier: PermissionClassifier | undefined;
  /** 已入队、尚未投递的消息（投递时发 queue_update）。 */
  private readonly queuedMessages = new WeakSet<object>();
  private readonly rewinder: RewindController;

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.manager = options.sessionManager;
    this.cwd = this.manager.cwd;
    this.depth = options.depth ?? 0;
    this.currentModel = options.model;
    this.currentThinking = options.thinkingLevel ?? "off";
    for (const tool of options.tools ?? []) this.allTools.set(tool.name, tool);
    this.activeNames = [...(options.activeTools ?? this.allTools.keys())].filter((name) =>
      this.allTools.has(name),
    );
    this.systemInput = { ...(options.system ?? {}) };
    this.retrySettings = resolveRetrySettings(options.retry);
    this.cache = new SessionCacheController(this, resolveCacheSettings(options.cache), {
      decider: () => options.warmingDecider?.(),
    });
    this.stream = this.cache.wrapStream((model, context, streamOptions) => {
      const api = options.providers.getApi(model.api);
      if (api === undefined) {
        throw new AmaError(
          "provider_not_found",
          `no implementation registered for api ${model.api}`,
        );
      }
      return api.stream(model, context, streamOptions);
    });
    const runner = createToolRunnerOptions(this);
    const agentOptions: ConstructorParameters<typeof Agent>[0] = {
      hooks: {
        convertToLlm: (messages) =>
          convertToLlm(messages, {
            provider: this.currentModel.provider,
            model: this.currentModel.id,
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
      getModel: () => this.currentModel,
      getThinkingLevel: () => this.currentThinking,
      streamOptions: async () => {
        const apiKey = await this.resolveApiKey();
        const idle = options.idleTimeoutMs;
        return {
          sessionId: this.manager.id,
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
    return this.currentModel;
  }

  thinkingLevel(): ModelThinkingLevel {
    return this.currentThinking;
  }

  outputDir(): string | undefined {
    if (this.options.outputDir !== undefined) return this.options.outputDir;
    const dir = this.manager.directory();
    return dir === undefined ? undefined : join(dir, "outputs");
  }

  async resolveApiKey(): Promise<string | undefined> {
    try {
      const { provider, channel } = this.currentModel;
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
    return this.activeNames.includes(name) ? this.allTools.get(name) : undefined;
  }

  tool(name: string): ToolDefinition | undefined {
    return this.allTools.get(name);
  }

  activeToolNames(): string[] {
    return [...this.activeNames];
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
    syncSystemMessage(this, this.systemInput, this.getTools());
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

  async setModel(ref: string): Promise<void> {
    this.assertUsable();
    this.currentModel = findModelOrThrow(this.options.providers, ref);
    this.compaction.refresh();
    this.emit({ type: "model_changed", model: appendModelChange(this, this.currentModel) });
  }

  setThinkingLevel(level: ModelThinkingLevel): void {
    this.currentThinking = level;
    this.appendEntry({ type: "thinking_level_change", thinkingLevel: level });
    this.emit({ type: "thinking_level_changed", level });
  }

  setPermissionMode(mode: PermissionMode): void {
    this.options.permission?.setMode(mode);
    this.emit({ type: "permission_mode_changed", mode });
  }

  setActiveTools(names: string[]): void {
    const unknown = names.filter((name) => !this.allTools.has(name));
    if (unknown.length > 0)
      throw new AmaError("tool_not_found", `unknown tools: ${unknown.join(", ")}`);
    this.activeNames = [...new Set(names)];
  }

  /** 宿主 / SDK 在会话创建后追加工具（下次请求前以 system 补丁声明）。 */
  addTool(tool: ToolDefinition, active = true): void {
    if (this.allTools.has(tool.name))
      throw new AmaError("tool_exists", `tool ${tool.name} already exists`);
    this.allTools.set(tool.name, tool);
    if (active) this.activeNames.push(tool.name);
  }

  /** 更新系统提示的静态部分（SessionStart Hook 的 hookContext、宿主 instructions 等）。 */
  updateSystem(patch: Partial<Omit<SystemPromptInput, "tools" | "cwd">>): void {
    this.systemInput = { ...this.systemInput, ...patch };
  }

  setAutoCompaction(enabled: boolean): void {
    this.compaction.setAuto(enabled);
  }

  setAutoRetry(enabled: boolean): void {
    this.retrySettings = { ...this.retrySettings, enabled };
  }

  getTools(): readonly ToolDefinition[] {
    return this.activeNames
      .map((name) => this.allTools.get(name))
      .filter((tool): tool is ToolDefinition => tool !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 发 session_start（bootstrap / SDK 在会话就绪后调用一次）。 */
  announceStart(reason: "startup" | "resume" | "new" | "fork"): void {
    this.emit(sessionStartEvent(this.manager, reason));
  }

  get state(): SessionState {
    return buildSessionState({
      agent: this.agent,
      manager: this.manager,
      model: this.currentModel,
      thinkingLevel: this.currentThinking,
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
    const contextWindow = this.currentModel.contextWindow;
    return computeStats({
      sessionId: this.manager.id,
      sessionFile: this.manager.file(),
      branch: this.manager.branch(),
      contextTokens,
      contextWindow,
      cache: this.cache.stats({ tokens: contextTokens, window: contextWindow }),
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.abort();
    this.cache.dispose();
    this.disposed = true;
    this.manager.close();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // 子 Agent（ToolContext.spawnSubagent，供 B3 的 task 工具）
  // -------------------------------------------------------------------------

  childBase(): Pick<AgentSessionOptions, "model" | "thinkingLevel" | "activeTools" | "system"> {
    return {
      model: this.currentModel,
      thinkingLevel: this.currentThinking,
      activeTools: this.activeNames,
      system: this.systemInput,
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
