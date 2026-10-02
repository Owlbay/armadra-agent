/**
 * 会话层重试（设计 §3.6「重试」「溢出」）。[B2]
 *
 * 判定顺序：上下文溢出（不重试，走压缩）→ 不可重试（配额 / 计费 / key / 401 / 403，快速失败）→
 * 可重试（429、5xx、overloaded、网络错误、断流）→ 其它（不重试）。
 * 延迟 `baseDelayMs × 2^(attempt−1)`，上限 `maxDelayMs`；`sleep` 可被 abort 打断。
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

export type FailureKind = "overflow" | "fatal" | "retryable" | "other";

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

const RETRYABLE_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /rate[_ ]?limit/i,
  /too many requests/i,
  /\b5\d\d\b/,
  /overloaded/i,
  /server error/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /timed? ?out/i,
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
  if (RETRYABLE_PATTERNS.some((pattern) => pattern.test(text))) return "retryable";
  return "other";
}

export function resolveRetrySettings(partial: Partial<RetrySettings> = {}): RetrySettings {
  return { ...DEFAULT_RETRY_SETTINGS, ...partial };
}

/** 第 attempt 次重试（1 起）前的等待。 */
export function retryDelayMs(attempt: number, settings: RetrySettings): number {
  const raw = settings.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, settings.maxDelayMs);
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
