/**
 * 会话层缓存控制器（第三波 §1.2、§1.5–§1.7、§1.9、§1.10）。[W3-C1b]
 *
 * `wrapStream()` 包住会话的流函数：每次真实请求记一条 `RequestRecord`（内存）、算前缀指纹、
 * 更新三态、检测未命中（发 `cache_miss`）、跨 70% / 90% 发 `context_pressure`，turn 请求完成后
 * 交给保温状态机。摘要请求自成一条链，不与主链比对；压缩 / 分支摘要 / 档一裁剪 / `/tree`
 * 之后的首个请求是重置点。子会话（depth > 0）有自己的控制器，`warmSubagents` 为 false 时不保温。
 * fork 出的会话沿用根会话 id 作 `prompt_cache_key`（只是路由提示）；task 子会话不沿用。
 */

import { readFileSync } from "node:fs";
import { evaluateWarm } from "../ai/cache/economics.js";
import { fingerprintContext } from "../ai/cache/fingerprint.js";
import { DEFAULT_MIN_CACHE_TOKENS, IMPLICIT_CACHE_TTL_MS, detectMiss } from "../ai/cache/miss.js";
import {
  endpointKey,
  sharedCacheReporting,
  type CacheReportingTracker,
} from "../ai/cache/reporting.js";
import type {
  CacheMissReason,
  CacheReporting,
  RequestRecord,
  WarmingDecisionHandler,
  WarmingMode,
} from "../ai/cache/types.js";
import { CacheWarmer, replayBlocker, type WarmerTimers } from "../ai/cache/warmer.js";
import type { AssistantMessage, CacheRetention, Model, StreamOptions } from "../ai/types.js";
import type { SessionManager } from "../session/manager.js";
import type { AgentMessage } from "../session/types.js";
import type { StreamFn } from "./loop.js";
import type { SessionCore } from "./session-core.js";
import type { CacheSettings, SessionCacheStats } from "./types.js";

export const DEFAULT_CACHE_SETTINGS: Readonly<CacheSettings> = Object.freeze({
  warming: "streaming",
  retention: "short",
  minSavingsUsd: 0.05,
  missNotices: true,
  warmSubagents: false,
});

export const PRESSURE_THRESHOLDS = [70, 90] as const;
const GROWTH_SAMPLES = 5;
const TASK_CUSTOM_TYPE = "ama.task";

export function resolveCacheSettings(partial: Partial<CacheSettings> = {}): CacheSettings {
  const settings = { ...DEFAULT_CACHE_SETTINGS };
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) (settings as Record<string, unknown>)[key] = value;
  }
  return settings;
}

export interface SessionCacheDeps {
  now?(): number;
  timers?: WarmerTimers;
  /** 缺省进程内共享的 `sharedCacheReporting`。 */
  tracker?: CacheReportingTracker;
  /** 宿主 `cache.onWarmingDecision` 的处理器（每次刷新前现取）。 */
  decider?(): WarmingDecisionHandler | undefined;
}

/** 目录 TTL（毫秒）：long 保留且有 long 档时用 long；无承诺 → undefined。 */
export function cacheTtlMs(model: Model, retention?: CacheRetention): number | undefined {
  const cache = model.promptCache;
  const seconds = retention === "long" && cache?.long !== undefined ? cache.long : cache?.short;
  return seconds === undefined ? undefined : seconds * 1000;
}

function readHead(file: string): { id?: string; parentSession?: string; task: boolean } {
  try {
    const [header, first] = readFileSync(file, "utf8").split("\n", 2);
    const parsed = JSON.parse(header ?? "{}") as { id?: string; parentSession?: string };
    const entry = first ? (JSON.parse(first) as { customType?: string }) : undefined;
    return { ...parsed, task: entry?.customType === TASK_CUSTOM_TYPE };
  } catch {
    return { task: false };
  }
}

/** fork 链上的根会话 id（task 子会话与非 fork 会话用自己的 id）。 */
export function cacheKeyOf(manager: SessionManager): string {
  const header = manager.header();
  const isTask = manager
    .entries()
    .some((entry) => entry.type === "custom" && entry.customType === TASK_CUSTOM_TYPE);
  if (header.parentSession === undefined || isTask) return manager.id;
  let id = manager.id;
  let file: string | undefined = header.parentSession;
  for (let depth = 0; depth < 8 && file !== undefined; depth++) {
    const head = readHead(file);
    if (head.id === undefined || head.task) break;
    id = head.id;
    file = head.parentSession;
  }
  return id;
}

interface TurnSnapshot {
  messages: readonly AgentMessage[];
  tools: string;
  thinking: string | undefined;
}

export class SessionCacheController {
  private readonly core: SessionCore;
  private settings: CacheSettings;
  private readonly now: () => number;
  private readonly tracker: CacheReportingTracker;
  private readonly decider: () => WarmingDecisionHandler | undefined;
  private readonly warmer: CacheWarmer;
  private readonly models = new WeakMap<RequestRecord, Model>();
  private readonly snapshots = new WeakMap<RequestRecord, TurnSnapshot>();
  private readonly replaced = new WeakSet<RequestRecord>();
  private inner: StreamFn | undefined;
  private warmingOverride: WarmingMode | undefined;
  private cacheKey: string | undefined;
  private prev: RequestRecord | undefined;
  private lastTurnRecord: RequestRecord | undefined;
  private resetPending = false;
  private disposed = false;
  private activeTasks = 0;
  private taskSince = 0;
  private taskMs = 0;
  private readonly sums = new Map<string, { read: number; prompt: number }>();
  private missCount = 0;
  private readonly byReason: Partial<Record<CacheMissReason, number>> = {};
  private reBilledTokens = 0;
  private reBilledUsd: number | undefined = 0;
  private readonly growth: number[] = [];
  private lastPercent = 0;
  private readonly subagents = { count: 0, read: 0, prompt: 0, reBilledTokens: 0 };

  constructor(core: SessionCore, settings: CacheSettings, deps: SessionCacheDeps = {}) {
    this.core = core;
    this.settings = settings;
    this.now = deps.now ?? (() => Date.now());
    this.tracker = deps.tracker ?? sharedCacheReporting;
    this.decider = deps.decider ?? (() => undefined);
    const warmerDeps: ConstructorParameters<typeof CacheWarmer>[0] = {
      mode: () => this.mode(),
      now: this.now,
      send: (record, signal) => this.replay(record, signal),
      isCurrent: (record) => this.isCurrent(record),
      evaluate: (record, phase) =>
        evaluateWarm(this.modelOf(record), record.promptTokens, phase, this.settings.minSavingsUsd),
      decide: (decision) => this.decider()?.(decision) ?? decision.action,
      onWarmed: (record, message, sentAt) => this.onWarmed(record, message, sentAt),
      onScheduled: (nextWarmAt) =>
        this.core.emit({ type: "cache_warm", phase: "scheduled", nextWarmAt }),
      onStopped: (reason) => this.core.emit({ type: "cache_warm", phase: "stopped", reason }),
    };
    if (deps.timers !== undefined) warmerDeps.timers = deps.timers;
    this.warmer = new CacheWarmer(warmerDeps);
  }

  /** 生效的保温模式：子会话在 warmSubagents 为 false 时 off；`/cache warm` 会话内覆盖。 */
  mode(): WarmingMode {
    if (this.core.depth > 0 && !this.settings.warmSubagents) return "off";
    return this.warmingOverride ?? this.settings.warming;
  }

  get cacheSettings(): Readonly<CacheSettings> {
    return this.settings;
  }

  setWarming(mode: WarmingMode): void {
    this.warmingOverride = mode;
    if (mode === "off") this.warmer.cancel();
  }

  /** 最后一条 turn 请求（摘要续写的前缀依据）。 */
  get lastTurn(): RequestRecord | undefined {
    return this.lastTurnRecord;
  }

  wrapStream(inner: StreamFn): StreamFn {
    this.inner = inner;
    return (model, context, options) => {
      const purpose = options.purpose ?? "turn";
      if (this.disposed || purpose === "warm" || purpose === "probe") {
        return inner(model, context, options);
      }
      const sent: StreamOptions = { ...options };
      let snapshot: TurnSnapshot | undefined;
      let subtaskMs = 0;
      const at = this.now();
      if (purpose === "turn") {
        sent.cacheRetention ??= this.settings.retention;
        if (sent.sessionId !== undefined && sent.sessionId === this.core.manager.id) {
          this.cacheKey ??= cacheKeyOf(this.core.manager);
          sent.sessionId = this.cacheKey;
        }
        this.warmer.pause();
        snapshot = {
          messages: this.core.agent.messages.slice(),
          tools: this.toolsKey(),
          thinking: options.thinkingLevel,
        };
        subtaskMs = this.takeTaskMs(at);
      }
      let replaced = false;
      const onPayload = options.onPayload;
      if (onPayload !== undefined) {
        sent.onPayload = (payload) => {
          const result = onPayload(payload);
          if (result !== undefined) replaced = true;
          return result;
        };
      }
      const stream = inner(model, context, sent);
      void stream.result().then(
        (message) => {
          if (this.disposed || message.stopReason === "error" || message.stopReason === "aborted")
            return;
          const { signal: _signal, ...rest } = sent;
          const stored: Omit<StreamOptions, "signal"> = { ...rest };
          if (onPayload !== undefined) stored.onPayload = onPayload;
          const usage = message.usage;
          const record: RequestRecord = {
            at,
            purpose,
            model: { provider: model.provider, id: model.id },
            api: model.api,
            baseUrl: model.baseUrl ?? "",
            fingerprint: fingerprintContext(context, model),
            promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
            usage,
            contextRef: context,
            options: stored,
          };
          this.models.set(record, model);
          if (snapshot !== undefined) this.snapshots.set(record, snapshot);
          if (replaced) this.replaced.add(record);
          this.observe(record, model, subtaskMs);
        },
        () => undefined,
      );
      return stream;
    };
  }

  /** 会话事件（AgentSessionImpl.emit 转交）。 */
  onEvent(event: Parameters<SessionCore["emit"]>[0]): void {
    switch (event.type) {
      case "agent_settled":
        this.onAgentSettled();
        return;
      case "model_changed":
      case "thinking_level_changed":
      case "compaction_start":
        this.warmer.cancel();
        return;
      case "entry_appended": {
        const { entry } = event;
        if (
          entry.type === "compaction" ||
          entry.type === "branch_summary" ||
          (entry.type === "context_edit" && entry.reason === "prune")
        ) {
          this.onContextChanged();
        }
        return;
      }
      case "tool_execution_start":
        if (event.toolName === "task" && this.activeTasks++ === 0) this.taskSince = this.now();
        return;
      case "tool_execution_end":
        if (event.toolName === "task" && this.activeTasks > 0 && --this.activeTasks === 0)
          this.taskMs += this.now() - this.taskSince;
        return;
      default:
        return;
    }
  }

  onAgentSettled(): void {
    this.warmer.onAgentSettled();
  }

  /** 压缩 / context_edit / setModel / navigate 之后：下一条请求是重置点，保温作废。 */
  onContextChanged(): void {
    this.resetPending = true;
    this.warmer.cancel();
  }

  /** task 子会话结束时由父会话汇总（各自独立统计）。 */
  addSubagent(tokens: { cacheRead: number; prompt: number }, reBilledTokens: number): void {
    this.subagents.count++;
    this.subagents.read += tokens.cacheRead;
    this.subagents.prompt += tokens.prompt;
    this.subagents.reBilledTokens += reBilledTokens;
  }

  stats(
    context: { tokens?: number | undefined; window?: number | undefined } = {},
  ): SessionCacheStats {
    const model = this.core.model();
    const setting = model.compat?.cacheReporting;
    const reporting = this.tracker.get(
      endpointKey({ model, baseUrl: model.baseUrl ?? "" }),
      setting,
    );
    const stats: SessionCacheStats = {
      reporting,
      reBilledTokens: this.reBilledTokens,
      misses: { count: this.missCount, byReason: { ...this.byReason } },
      warming: this.warmer.status,
    };
    const last = this.lastTurnRecord;
    if (reporting === "reported" && last !== undefined && last.promptTokens > 0)
      stats.lastHitRate = last.usage.cacheRead / last.promptTokens;
    let read = 0;
    let prompt = 0;
    for (const [key, sum] of this.sums) {
      if (this.tracker.get(key) !== "reported") continue;
      read += sum.read;
      prompt += sum.prompt;
    }
    if (prompt > 0) stats.hitRate = read / prompt;
    if (this.reBilledUsd !== undefined) stats.reBilledUsd = this.reBilledUsd;
    if (context.tokens !== undefined && context.window !== undefined) {
      const remaining = Math.max(0, context.window - context.tokens);
      stats.contextRemainingTokens = remaining;
      const turns = this.turnsLeft(remaining);
      if (turns !== undefined) stats.estimatedTurnsLeft = turns;
    }
    if (this.subagents.count > 0) {
      const sub: NonNullable<SessionCacheStats["subagents"]> = {
        count: this.subagents.count,
        reBilledTokens: this.subagents.reBilledTokens,
      };
      if (this.subagents.prompt > 0) sub.hitRate = this.subagents.read / this.subagents.prompt;
      stats.subagents = sub;
    }
    return stats;
  }

  dispose(): void {
    this.disposed = true;
    this.warmer.cancel();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private modelOf(record: RequestRecord): Model {
    return this.models.get(record) ?? this.core.model();
  }

  private toolsKey(): string {
    return this.core.activeToolNames().sort().join(",");
  }

  private takeTaskMs(at: number): number {
    let total = this.taskMs;
    if (this.activeTasks > 0) {
      total += at - this.taskSince;
      this.taskSince = at;
    }
    this.taskMs = 0;
    return total;
  }

  private turnsLeft(remaining: number): number | undefined {
    if (this.growth.length === 0) return undefined;
    const average = this.growth.reduce((a, b) => a + b, 0) / this.growth.length;
    return average > 0 ? Math.floor(remaining / average) : undefined;
  }

  private observe(record: RequestRecord, model: Model, subtaskMs: number): CacheReporting {
    const minTokens = model.promptCache?.minTokens ?? DEFAULT_MIN_CACHE_TOKENS;
    const ttl = cacheTtlMs(model, record.options.cacheRetention);
    const reporting = this.tracker.observe(
      record,
      minTokens,
      ttl ?? IMPLICIT_CACHE_TTL_MS,
      model.compat?.cacheReporting,
    );
    const key = endpointKey(record);
    const sum = this.sums.get(key) ?? { read: 0, prompt: 0 };
    sum.read += record.usage.cacheRead;
    sum.prompt += record.promptTokens;
    this.sums.set(key, sum);
    if (record.purpose !== "turn") return reporting;

    const prev = this.resetPending ? undefined : this.prev;
    const lastTurn = this.resetPending ? undefined : this.lastTurnRecord;
    this.resetPending = false;
    const missOptions: Parameters<typeof detectMiss>[3] = { reporting, minTokens, subtaskMs };
    if (model.cost !== undefined) missOptions.cost = model.cost;
    const miss = detectMiss(prev, record, ttl, missOptions);
    if (miss !== undefined) {
      this.missCount++;
      this.byReason[miss.reason] = (this.byReason[miss.reason] ?? 0) + 1;
      this.reBilledTokens += miss.missedTokens;
      this.reBilledUsd =
        this.reBilledUsd === undefined || miss.missedCost === undefined
          ? undefined
          : this.reBilledUsd + miss.missedCost;
      this.core.emit({ type: "cache_miss", ...miss });
    }
    if (lastTurn !== undefined && record.promptTokens > lastTurn.promptTokens) {
      this.growth.push(record.promptTokens - lastTurn.promptTokens);
      if (this.growth.length > GROWTH_SAMPLES) this.growth.shift();
    }
    this.prev = record;
    this.lastTurnRecord = record;
    this.checkPressure(record, model);
    this.scheduleWarm(record, model, reporting, ttl);
    return reporting;
  }

  private checkPressure(record: RequestRecord, model: Model): void {
    const window = model.contextWindow;
    if (window === undefined || window <= 0) return;
    const used = record.promptTokens + record.usage.output;
    const percent = Math.min(100, Math.round((used / window) * 1000) / 10);
    const before = this.lastPercent;
    this.lastPercent = percent;
    for (const threshold of PRESSURE_THRESHOLDS) {
      if (before >= threshold || percent < threshold) continue;
      const remainingTokens = Math.max(0, window - used);
      const event: Parameters<SessionCore["emit"]>[0] = {
        type: "context_pressure",
        percent,
        threshold,
        remainingTokens,
      };
      const turns = this.turnsLeft(remainingTokens);
      if (turns !== undefined) event.estimatedTurnsLeft = turns;
      this.core.emit(event);
    }
  }

  private scheduleWarm(
    record: RequestRecord,
    model: Model,
    reporting: CacheReporting,
    ttl: number | undefined,
  ): void {
    if (this.mode() === "off") return this.warmer.cancel();
    const blocker = replayBlocker({
      model,
      options: record.options,
      payloadReplaced: this.replaced.has(record),
      reporting,
    });
    if (blocker !== undefined) return this.warmer.block(blocker);
    if (ttl === undefined) return this.warmer.block("no_ttl");
    if (this.decider() === undefined) {
      const decision = evaluateWarm(
        model,
        record.promptTokens,
        "streaming",
        this.settings.minSavingsUsd,
      );
      if (decision.action === "stop") return this.warmer.block(decision.reason ?? "declined");
    }
    this.warmer.start(record, ttl);
  }

  private isCurrent(record: RequestRecord): boolean {
    const model = this.core.model();
    if (model.provider !== record.model.provider || model.id !== record.model.id) return false;
    const snapshot = this.snapshots.get(record);
    if (snapshot === undefined) return false;
    if (snapshot.thinking !== undefined && snapshot.thinking !== this.core.thinkingLevel())
      return false;
    if (snapshot.tools !== this.toolsKey()) return false;
    const current = this.core.agent.messages;
    if (current.length < snapshot.messages.length) return false;
    return snapshot.messages.every((message, i) => current[i] === message);
  }

  private async replay(record: RequestRecord, signal: AbortSignal): Promise<AssistantMessage> {
    const inner = this.inner;
    if (inner === undefined) throw new Error("stream not wrapped");
    const options: StreamOptions = { ...record.options, maxTokens: 1, purpose: "warm", signal };
    return inner(this.modelOf(record), record.contextRef, options).result();
  }

  private onWarmed(record: RequestRecord, message: AssistantMessage, sentAt: number): void {
    const usage = message.usage;
    try {
      this.core.appendEntry({
        type: "usage",
        kind: "cache_warm",
        provider: record.model.provider,
        model: record.model.id,
        usage,
      });
    } catch (error) {
      this.core.log("debug", `cache warm usage not recorded: ${String(error)}`);
    }
    const event: Parameters<SessionCore["emit"]>[0] = { type: "cache_warm", phase: "sent", usage };
    if (usage.cost !== undefined) event.cost = usage.cost.total;
    this.core.emit(event);
    const warm: RequestRecord = {
      ...record,
      at: sentAt,
      purpose: "warm",
      usage,
      promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    };
    const model = this.modelOf(record);
    this.models.set(warm, model);
    const minTokens = model.promptCache?.minTokens ?? DEFAULT_MIN_CACHE_TOKENS;
    this.tracker.observe(warm, minTokens, cacheTtlMs(model), model.compat?.cacheReporting);
    const sum = this.sums.get(endpointKey(warm));
    if (sum !== undefined) {
      sum.read += usage.cacheRead;
      sum.prompt += warm.promptTokens;
    }
    if (!this.resetPending) this.prev = warm;
  }
}
