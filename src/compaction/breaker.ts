/**
 * 压缩熔断（设计 §9「熔断」）。[B2]
 *
 * - 无 `contextWindow` 或配置关闭 → 自动压缩关闭（手动 /compact 仍可用）。
 * - 同一 run 内档二（摘要）≤ 1 次（`startRun()` 重置计数）。
 * - 连续两次摘要失败 → 跳闸，关闭自动压缩直到 `reset()`（例如用户手动压缩成功）。
 * - 溢出恢复：压缩后估算仍 > 0.8 × window → 不重试。
 */

export const MAX_SUMMARIES_PER_RUN = 1;
export const MAX_CONSECUTIVE_FAILURES = 2;
export const RETRY_AFTER_COMPACTION_RATIO = 0.8;

export type BreakerBlockReason = "disabled" | "no_window" | "tripped" | "run_limit";

export class CompactionBreaker {
  private summariesThisRun = 0;
  private consecutiveFailures = 0;
  private enabled: boolean;
  private contextWindow: number | undefined;

  constructor(enabled: boolean, contextWindow: number | undefined) {
    this.enabled = enabled;
    this.contextWindow = contextWindow;
  }

  configure(enabled: boolean, contextWindow: number | undefined): void {
    this.enabled = enabled;
    this.contextWindow = contextWindow;
  }

  get tripped(): boolean {
    return this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  }

  /** 自动压缩整体是否开启（不看本 run 计数）。 */
  get autoEnabled(): boolean {
    return this.enabled && this.contextWindow !== undefined && !this.tripped;
  }

  startRun(): void {
    this.summariesThisRun = 0;
  }

  /** 自动档二能否执行；不能则给出原因。 */
  blockReason(): BreakerBlockReason | undefined {
    if (!this.enabled) return "disabled";
    if (this.contextWindow === undefined) return "no_window";
    if (this.tripped) return "tripped";
    if (this.summariesThisRun >= MAX_SUMMARIES_PER_RUN) return "run_limit";
    return undefined;
  }

  canSummarize(): boolean {
    return this.blockReason() === undefined;
  }

  recordSummary(success: boolean): void {
    this.summariesThisRun++;
    this.consecutiveFailures = success ? 0 : this.consecutiveFailures + 1;
  }

  /** 手动压缩成功等场景：清零失败计数。 */
  reset(): void {
    this.consecutiveFailures = 0;
    this.summariesThisRun = 0;
  }

  /** 溢出恢复后是否值得重试。 */
  shouldRetryAfterCompaction(tokensAfter: number): boolean {
    if (this.contextWindow === undefined) return false;
    return tokensAfter <= RETRY_AFTER_COMPACTION_RATIO * this.contextWindow;
  }
}
