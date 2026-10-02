/**
 * 探测的执行层（`ama providers add|refresh --probe`、`ama models discover --probe` 共用）。
 *
 * - **首事件即判定**：HTTP 成功、流里出现第一个内容事件（text / thinking / toolcall）或 done 即判可用，
 *   立刻中止请求；只见到 `start`（推理模型可能要想很久才出第一个 delta）时再等 `settleMs`，期间没有
 *   error 事件也判可用——防止中转先回 200、紧接着在流里报错被误判。HTTP 错误、流 error 事件、超时判不可用。
 * - **有界并发**：同时在途 ≤ `concurrency`；结果按任务下标交回，调用方自己按顺序输出。
 * - **限流**：429 时并发减半（至少 1），等 `retryDelayMs` 后重试该请求一次；重试仍 429 → 停止；
 *   401 / 403 → 立即停止。停止后不再发新请求，并中止在途的请求（它们的结果标记为 aborted）。
 * - **恢复（加法增、乘法减）**：降并发之后，每连续 `recoverAfter`（缺省 4）次没被限流的请求，并发 +1，
 *   直到回到初始并发；中途再遇 429 重新减半、计数清零。
 *
 * `ama models check` 不走这里：它只发一次，要看到完整回复与耗时。
 */

import type { Model, ProviderRegistryApi } from "../../ai/types.js";
import { UsageError } from "../args.js";

export const PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_PROBE_CONCURRENCY = 6;
export const MAX_PROBE_CONCURRENCY = 16;
export const PROBE_SETTLE_MS = 1_000;
export const RATE_LIMIT_RETRY_MS = 2_000;
/** 降并发后，连续多少次没被限流才 +1。 */
export const RECOVER_AFTER = 4;

/** 鉴权失败或限流：继续只会浪费请求。 */
export const FATAL_STATUS = /^(?:HTTP )?(?:401|403|429)\b/;
const RATE_LIMITED = /^(?:HTTP )?429\b/;

export interface ProbeTuning {
  timeoutMs?: number | undefined;
  settleMs?: number | undefined;
}

/** 一次探测请求的结果：error 为 undefined 即可用；aborted 表示被调度方中止，结果作废。 */
export interface ProbeOutcome {
  error?: string;
  aborted?: boolean;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** 发一次最小请求，见到首个有效事件即判定并中止。 */
export async function probeOnce(
  registry: ProviderRegistryApi,
  model: Model,
  apiKey: string | undefined,
  tuning: ProbeTuning = {},
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const impl = registry.getApi(model.api);
  if (impl === undefined) return { error: `协议 ${model.api} 尚未实现` };
  if (signal?.aborted) return { aborted: true };
  const timeoutMs = tuning.timeoutMs ?? PROBE_TIMEOUT_MS;
  const settleMs = tuning.settleMs ?? PROBE_SETTLE_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const verdict = (outcome: ProbeOutcome): ProbeOutcome => {
    if (signal?.aborted) return { aborted: true };
    if (timedOut) return { error: `超时（${Math.round(timeoutMs / 1000)} s 内没有响应）` };
    return outcome;
  };
  try {
    const stream = impl.stream(
      model,
      { messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] },
      {
        signal: controller.signal,
        ...(apiKey !== undefined ? { apiKey } : {}),
        maxTokens: 16,
        cacheRetention: "none",
        purpose: "probe",
      },
    );
    const events = stream[Symbol.asyncIterator]();
    let settled: Promise<"settled"> | undefined;
    while (true) {
      const next = events.next();
      const step = settled !== undefined ? await Promise.race([next, settled]) : await next;
      if (step === "settled") return verdict({});
      if (step.done) break;
      const event = step.value;
      if (event.type === "error")
        return verdict({ error: event.message.errorMessage ?? event.reason });
      if (event.type === "start") {
        settled ??= sleep(settleMs, controller.signal).then(() => "settled" as const);
        continue;
      }
      return verdict({});
    }
    // 流没有逐个产出事件（实现只给 result）：按最终消息判定
    const message = await stream.result();
    if (message.stopReason === "error" || message.stopReason === "aborted")
      return verdict({ error: message.errorMessage ?? message.stopReason });
    return verdict({});
  } catch (error) {
    return verdict({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    // 判定后立刻断开：不等推理模型把 16 个 token 想完
    controller.abort();
  }
}

export interface SchedulerOptions extends ProbeTuning {
  concurrency?: number | undefined;
  retryDelayMs?: number | undefined;
  /** 429 降并发时回调（新的并发数）。 */
  onThrottle?: (concurrency: number) => void;
  /** 连续多少次没被限流后并发 +1（缺省 RECOVER_AFTER）。 */
  recoverAfter?: number | undefined;
  /** 并发回升时回调（新的并发数）。 */
  onRecover?: (concurrency: number) => void;
}

/**
 * 有界并发的探测调度器：`run` 按下标调度任务，任务里用 `probe` 发请求（带 429 重试与停止判定）。
 */
export class ProbeScheduler {
  private limit: number;
  private readonly initial: number;
  /** 上次降并发以来连续没被限流的请求数。 */
  private streak = 0;
  private readonly controller = new AbortController();
  private stopReason: string | undefined;
  private active = 0;
  /** 观测用：同时在途请求数的峰值。 */
  peak = 0;

  constructor(
    private readonly registry: ProviderRegistryApi,
    private readonly apiKey: string | undefined,
    private readonly options: SchedulerOptions = {},
  ) {
    this.limit = options.concurrency ?? DEFAULT_PROBE_CONCURRENCY;
    this.initial = this.limit;
  }

  get stopped(): string | undefined {
    return this.stopReason;
  }

  get concurrency(): number {
    return this.limit;
  }

  stop(reason: string): void {
    if (this.stopReason !== undefined) return;
    this.stopReason = reason;
    this.controller.abort();
  }

  /** 一次探测；429 降并发、退避后重试一次，仍 429 或 401 / 403 → 停止。 */
  async probe(model: Model): Promise<ProbeOutcome> {
    if (this.stopReason !== undefined) return { aborted: true };
    let outcome = await probeOnce(this.registry, model, this.apiKey, this.options, this.signal);
    if (outcome.error !== undefined && RATE_LIMITED.test(outcome.error)) {
      this.limit = Math.max(1, Math.floor(this.limit / 2));
      this.streak = 0;
      this.options.onThrottle?.(this.limit);
      await sleep(this.options.retryDelayMs ?? RATE_LIMIT_RETRY_MS, this.signal);
      if (this.stopReason !== undefined) return { aborted: true };
      outcome = await probeOnce(this.registry, model, this.apiKey, this.options, this.signal);
      if (outcome.error !== undefined && RATE_LIMITED.test(outcome.error)) {
        this.stop(`连续 429 限流：${outcome.error}`);
        return outcome;
      }
    }
    if (outcome.error !== undefined && FATAL_STATUS.test(outcome.error)) this.stop(outcome.error);
    else if (outcome.aborted !== true) this.recover();
    return outcome;
  }

  /** 一次没被限流的请求：攒够 recoverAfter 次就并发 +1（不超过初始值）。 */
  private recover(): void {
    if (this.limit >= this.initial) return;
    this.streak++;
    if (this.streak < (this.options.recoverAfter ?? RECOVER_AFTER)) return;
    this.streak = 0;
    this.limit++;
    this.options.onRecover?.(this.limit);
  }

  /** 并发执行 `count` 个任务；`onDone` 按完成顺序回调。停止后未开始的任务不执行（结果为 undefined）。 */
  async run<T>(
    count: number,
    task: (index: number) => Promise<T>,
    onDone?: (index: number, result: T) => void,
  ): Promise<(T | undefined)[]> {
    const results: (T | undefined)[] = new Array<T | undefined>(count).fill(undefined);
    let next = 0;
    await new Promise<void>((resolve, reject) => {
      const pump = (): void => {
        while (this.stopReason === undefined && next < count && this.active < this.limit) {
          const index = next++;
          this.active++;
          this.peak = Math.max(this.peak, this.active);
          task(index).then(
            (result) => {
              this.active--;
              results[index] = result;
              onDone?.(index, result);
              pump();
            },
            (error: unknown) => {
              this.active--;
              this.stop(error instanceof Error ? error.message : String(error));
              reject(error);
            },
          );
        }
        if (this.active === 0 && (next >= count || this.stopReason !== undefined)) resolve();
      };
      pump();
    });
    return results;
  }

  private get signal(): AbortSignal {
    return this.controller.signal;
  }
}

/** `--concurrency`（1–16）与 `--probe-timeout`（毫秒，1000–300000）。 */
export function parseProbeTuning(values: ReadonlyMap<string, string>): {
  concurrency: number;
  timeoutMs: number;
} {
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new UsageError(`--${name} 需要 ${min}–${max} 的整数：${raw}`);
    return n;
  };
  return {
    concurrency: int("concurrency", DEFAULT_PROBE_CONCURRENCY, 1, MAX_PROBE_CONCURRENCY),
    timeoutMs: int("probe-timeout", PROBE_TIMEOUT_MS, 1_000, 300_000),
  };
}

/** 预估文案：`并发 6，单次最长 15 s，预计不超过 150 s`。 */
export function describeProbePlan(
  requests: number,
  concurrency: number,
  timeoutMs: number,
): string {
  const worst = Math.ceil(requests / concurrency) * Math.ceil(timeoutMs / 1000);
  return `并发 ${concurrency}，单次最长 ${Math.round(timeoutMs / 1000)} s，预计不超过 ${worst} s`;
}

/** 进度：TTY 下单行刷新「探测 18/60」；非 TTY 只在结束时打印一行汇总。 */
export class ProbeProgress {
  private done = 0;
  private shown = false;
  private readonly started = Date.now();

  constructor(
    private readonly write: (text: string) => void,
    private readonly tty: boolean,
    private readonly total: number,
  ) {}

  /** 输出一行结果（TTY 下先擦掉进度行，再重画）。 */
  line(text: string): void {
    this.clear();
    this.write(text);
    this.draw();
  }

  tick(): void {
    this.done++;
    this.draw();
  }

  finish(): void {
    this.clear();
    const seconds = ((Date.now() - this.started) / 1000).toFixed(1);
    this.write(`探测完成 ${this.done}/${this.total}，用时 ${seconds} s\n`);
  }

  private draw(): void {
    if (!this.tty) return;
    this.write(`\r\x1b[2K探测 ${this.done}/${this.total}`);
    this.shown = true;
  }

  private clear(): void {
    if (!this.tty || !this.shown) return;
    this.write("\r\x1b[2K");
    this.shown = false;
  }
}
