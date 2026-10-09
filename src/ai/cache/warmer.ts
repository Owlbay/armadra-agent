/**
 * 缓存保温状态机（第三波 §1.7）。[W3-C1b]
 *
 * 注入 now / 计时器 / 发送函数，fake 时钟可测：
 * - `start(record, ttlMs)`：每个 turn 请求完成后调用（替换上一轮）；计时**从请求发出算**：
 *   `delay = max(1s, floor(min(0.9·TTL, TTL − 10s)))`，TTL ≤ 10 s 不保温。
 * - 截止 `deadline = nextWarmAt + (TTL − delay) / 2`：计时器迟到超过截止（睡眠、事件循环阻塞）
 *   直接停——迟到的刷新大概率是一次全价写入。
 * - 上限：streaming 相 60 min、idle 相 30 min（从起始真实请求算）；连续 2 次保温响应读写都为
 *   0 即停。
 * - 每次刷新前：`isCurrent(record)` 不成立 → 停；内置经济性决策交给否决钩子 `decide`（出错
 *   回落内置决策）。
 * - `onAgentSettled()`：streaming 模式静默结束本轮；idle 模式转空闲相。
 * - `pause()`：真实请求发出时静默挂起（新请求本身就刷新了缓存）；`cancel()` 同时丢弃记录。
 * 只有已排期之后的异常停止（截止、上限、零命中、过期、否决、失败）回调 `onStopped`。
 */

import type { Api, AssistantMessage, Model, StreamOptions } from "../types.js";
import { expectedSavings } from "./economics.js";
import type {
  CacheReporting,
  RequestRecord,
  WarmDecision,
  WarmerState,
  WarmerStatus,
  WarmingMode,
  WarmingPhase,
} from "./types.js";

export const WARM_MIN_TTL_MS = 10_000;
export const WARM_STREAMING_CAP_MS = 60 * 60_000;
export const WARM_IDLE_CAP_MS = 30 * 60_000;
export const WARM_ZERO_HIT_LIMIT = 2;

export interface WarmerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** 真实计时器：`unref()`，保温不拖住进程退出。 */
export const REAL_TIMERS: WarmerTimers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface WarmerDeps {
  mode(): WarmingMode;
  now(): number;
  timers?: WarmerTimers;
  /** 重放：同 model / context / options，maxTokens 1，purpose warm，不经重试。 */
  send(record: RequestRecord, signal: AbortSignal): Promise<AssistantMessage>;
  /** 模型未变 && 记录的上下文仍是当前转录的同一引用前缀 && system 状态未变。 */
  isCurrent(record: RequestRecord): boolean;
  /** 内置经济性决策。 */
  evaluate(record: RequestRecord, phase: WarmingPhase): WarmDecision;
  /** 宿主 / 扩展否决钩子（每次现取）。 */
  decide?(decision: WarmDecision): Promise<"warm" | "stop"> | "warm" | "stop";
  onWarmed(record: RequestRecord, message: AssistantMessage, sentAt: number): void;
  onScheduled?(nextWarmAt: number): void;
  onStopped(reason: string): void;
}

/**
 * 保温重放的输出上限（[ME-B] D17）：Responses 的 `max_output_tokens` 下限是 16，其余协议 1。
 * 官方下限无法实测，按文档取值；中转同样适用。
 */
export function warmReplayMaxTokens(api: Api): number {
  return api === "openai-responses" ? 16 : 1;
}

export function warmDelay(ttlMs: number): number {
  return Math.max(1000, Math.floor(Math.min(0.9 * ttlMs, ttlMs - 10_000)));
}

export interface ReplayCheck {
  model: Pick<Model, "api" | "reasoning" | "compat">;
  options: Pick<StreamOptions, "cacheRetention" | "thinkingLevel">;
  /** `onPayload` 替换过请求体。 */
  payloadReplaced: boolean;
  reporting: CacheReporting;
}

/**
 * 不保温的原因（undefined = 可以保温）：
 * - `cacheRetention: "none"` 的请求；被 `onPayload` 替换过请求体的请求；
 * - anthropic-messages 开思考且不是自适应思考：预算从 `max_tokens` 推导，`max_tokens: 1` 会
 *   去掉 thinking 块、改变缓存键；
 * - 端点不是 `reported`（未知或不报缓存时看不出保温有没有用，第三波 §4 R2）。
 */
export function replayBlocker(check: ReplayCheck): string | undefined {
  if (check.options.cacheRetention === "none") return "retention_none";
  if (check.payloadReplaced) return "payload_replaced";
  const thinking =
    check.options.thinkingLevel !== undefined && check.options.thinkingLevel !== "off";
  if (
    check.model.api === "anthropic-messages" &&
    check.model.reasoning &&
    thinking &&
    check.model.compat?.adaptiveThinking !== true
  ) {
    return "thinking_budget";
  }
  if (check.reporting !== "reported") return `reporting_${check.reporting}`;
  return undefined;
}

export class CacheWarmer {
  private readonly deps: WarmerDeps;
  private readonly timers: WarmerTimers;
  private record: RequestRecord | undefined;
  private origin = 0;
  private ttl = 0;
  private phase: WarmingPhase = "streaming";
  private timer: unknown;
  private inflight: AbortController | undefined;
  private generation = 0;
  private zeroHits = 0;
  private state: WarmerState = "inactive";
  private reason: string | undefined;
  private nextWarmAt: number | undefined;
  private deadline = 0;
  private sent = 0;
  private costUsd = 0;
  private savings: number | undefined;

  constructor(deps: WarmerDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  start(record: RequestRecord, ttlMs: number): void {
    this.reset();
    this.record = record;
    this.origin = record.at;
    this.ttl = ttlMs;
    this.phase = "streaming";
    this.zeroHits = 0;
    if (this.deps.mode() === "off") return;
    if (ttlMs <= WARM_MIN_TTL_MS) return this.block("ttl_too_short");
    this.schedule(record.at);
  }

  /** 不排期并记下原因（无事件：不可重放、端点未报告、经济性不划算等）。 */
  block(reason: string): void {
    this.reset();
    this.state = "stopped";
    this.reason = reason;
  }

  onAgentSettled(): void {
    if (this.state !== "scheduled") return;
    if (this.deps.mode() === "idle") this.phase = "idle";
    else this.reset();
  }

  /** 真实请求发出：静默挂起，保留统计。 */
  pause(): void {
    this.reset();
  }

  cancel(): void {
    this.reset();
    this.record = undefined;
  }

  get status(): WarmerStatus {
    const status: WarmerStatus = { mode: this.deps.mode(), state: this.state };
    if (this.state === "scheduled") {
      status.phase = this.phase;
      if (this.nextWarmAt !== undefined) status.nextWarmAt = this.nextWarmAt;
    }
    if (this.state === "stopped" && this.reason !== undefined) status.reason = this.reason;
    if (this.sent > 0) {
      status.sent = this.sent;
      status.costUsd = this.costUsd;
    }
    if (this.savings !== undefined) status.expectedSavingsUsd = this.savings;
    return status;
  }

  private reset(): void {
    this.generation++;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.inflight?.abort();
    this.inflight = undefined;
    this.state = "inactive";
    this.reason = undefined;
    this.nextWarmAt = undefined;
  }

  private stop(reason: string): void {
    this.reset();
    this.state = "stopped";
    this.reason = reason;
    this.deps.onStopped(reason);
  }

  private cap(): number {
    return this.phase === "idle" ? WARM_IDLE_CAP_MS : WARM_STREAMING_CAP_MS;
  }

  private schedule(base: number): void {
    const delay = warmDelay(this.ttl);
    const next = base + delay;
    if (next - this.origin > this.cap()) return this.stop("max_duration");
    this.deadline = next + (this.ttl - delay) / 2;
    this.state = "scheduled";
    this.reason = undefined;
    this.nextWarmAt = next;
    const generation = this.generation;
    this.timer = this.timers.set(
      () => void this.fire(generation),
      Math.max(0, next - this.deps.now()),
    );
    this.deps.onScheduled?.(next);
  }

  private async decide(decision: WarmDecision): Promise<"warm" | "stop"> {
    const handler = this.deps.decide;
    if (handler === undefined) return decision.action;
    try {
      const answer = await handler(decision);
      return answer === "warm" || answer === "stop" ? answer : decision.action;
    } catch {
      return decision.action;
    }
  }

  private async fire(generation: number): Promise<void> {
    if (generation !== this.generation || this.record === undefined) return;
    this.timer = undefined;
    const record = this.record;
    const now = this.deps.now();
    const mode = this.deps.mode();
    if (now > this.deadline) return this.stop("late");
    if (mode === "off" || (this.phase === "idle" && mode !== "idle")) return this.stop("off");
    if (now - this.origin > this.cap()) return this.stop("max_duration");
    if (!this.deps.isCurrent(record)) return this.stop("stale");
    const decision = this.deps.evaluate(record, this.phase);
    const action = await this.decide(decision);
    if (generation !== this.generation) return;
    this.savings = expectedSavings(decision);
    if (action === "stop") return this.stop(decision.reason ?? "declined");
    const controller = new AbortController();
    this.inflight = controller;
    const sentAt = this.deps.now();
    let message: AssistantMessage | undefined;
    try {
      message = await this.deps.send(record, controller.signal);
    } catch {
      message = undefined;
    }
    if (generation !== this.generation) return;
    this.inflight = undefined;
    if (message === undefined || message.stopReason === "error" || message.stopReason === "aborted")
      return this.stop("error");
    this.sent++;
    this.costUsd += message.usage.cost?.total ?? 0;
    this.deps.onWarmed(record, message, sentAt);
    const hits = message.usage.cacheRead + message.usage.cacheWrite;
    this.zeroHits = hits === 0 ? this.zeroHits + 1 : 0;
    if (this.zeroHits >= WARM_ZERO_HIT_LIMIT) return this.stop("no_cache_hits");
    this.schedule(sentAt);
  }
}
