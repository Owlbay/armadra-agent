/**
 * 会话层重试（设计 §3.6「重试」「溢出」）。[B2]
 *
 * 判定顺序：上下文溢出（不重试，走压缩）→ 不可重试（配额 / 计费 / key / 401 / 403，快速失败）→
 * 限流（429、529、rate limit；[ME-C] 上限多 2 次）→ 可重试（5xx、overloaded、网络错误、断流、
 * 空闲超时）→ 其它（不重试）。5xx 只认文案开头的状态码或 `status` / `HTTP` 后的（「500 tokens」不算）。
 * 延迟 `min(maxDelayMs, max(baseDelayMs × 2^(attempt−1), Retry-After)) × U(0.8, 1.2)`（D8）；
 * `sleep` 可被 abort 打断。
 * 协议层自身不重试。溢出文案识别只有一份：ai/overflow.ts 的 `isOverflowErrorText`（缺省），可注入替换。
 */

import { isOverflowErrorText } from "../ai/overflow.js";
import type { AssistantMessage } from "../ai/types.js";
import { AmaError } from "../errors.js";
import type { RetrySettings } from "./types.js";

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 60_000,
};

export type FailureKind = "overflow" | "fatal" | "rate_limited" | "retryable" | "other";

const FATAL_PATTERNS: readonly RegExp[] = [
  /insufficient[_ ]quota/i,
  /quota exceeded/i,
  /billing/i,
  /monthly usage limit/i,
  /invalid[_ ]api[_ ]key/i,
  /incorrect api key/i,
  /no[_ ]api[_ ]key/i,
  /\b(?:401|403)\b/,
  /unauthori[sz]ed/i,
  /permission denied/i,
  /authentication/i,
];

/** 限流：先于 RETRYABLE_PATTERNS 判（529 overloaded 也在这里）。 */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /\b529\b/,
  /rate[_ ]?limit/i,
  /too many requests/i,
];

const RETRYABLE_PATTERNS: readonly RegExp[] = [
  /^\s*5\d\d\b/,
  /\b(?:status|HTTP)\s*[:=]?\s*5\d\d\b/i,
  /overloaded/i,
  /server error/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /timed? ?out/i,
  /idle timeout/i,
  /network/i,
  /fetch failed/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE/,
  /socket hang up/i,
  /stream (?:ended|closed|terminated)/i,
  /premature (?:close|end)/i,
  /terminated/i,
  /connection (?:reset|closed|error)/i,
];

export interface ClassifyOptions {
  isContextOverflow?: (errorMessage: string) => boolean;
}

/** 对 `stopReason: "error"` 的助手消息分类；`length` 且无工具调用也算 overflow。 */
export function classifyFailure(
  message: AssistantMessage,
  options: ClassifyOptions = {},
): FailureKind {
  if (message.stopReason === "length") {
    return message.content.some((block) => block.type === "toolCall") ? "other" : "overflow";
  }
  if (message.stopReason !== "error") return "other";
  const text = message.errorMessage ?? "";
  const isOverflow = options.isContextOverflow ?? isOverflowErrorText;
  if (isOverflow(text)) return "overflow";
  if (FATAL_PATTERNS.some((pattern) => pattern.test(text))) return "fatal";
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return "rate_limited";
  if (RETRYABLE_PATTERNS.some((pattern) => pattern.test(text))) return "retryable";
  return "other";
}

export function resolveRetrySettings(partial: Partial<RetrySettings> = {}): RetrySettings {
  return { ...DEFAULT_RETRY_SETTINGS, ...partial };
}

/** 会话层要重试的失败种类。 */
export function isRetryableKind(kind: FailureKind): boolean {
  return kind === "retryable" || kind === "rate_limited";
}

/** 该种类的重试上限：限流多给 2 次（服务端多半在 Retry-After 后就恢复）。 */
export function maxRetriesFor(kind: FailureKind, settings: RetrySettings): number {
  return kind === "rate_limited" ? settings.maxRetries + 2 : settings.maxRetries;
}

/**
 * 第 attempt 次重试（1 起）前的等待：指数退避与服务端 `Retry-After` 取大、截到 `maxDelayMs`，再乘
 * U(0.8, 1.2) 抖动（并发会话不在同一时刻一起重试）；取整到毫秒。
 */
export function retryDelayMs(
  attempt: number,
  settings: RetrySettings,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const backoff = settings.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const wanted = Math.max(backoff, retryAfterMs ?? 0);
  const capped = Math.min(wanted, settings.maxDelayMs);
  return Math.round(capped * (0.8 + 0.4 * random()));
}

/** 可被 abort 打断的等待；被打断时抛 AmaError{code:"aborted"}。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new AmaError("aborted", "aborted"));
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AmaError("aborted", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
