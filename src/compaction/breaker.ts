/**
 * 压缩熔断（设计 §9「熔断」，wave5 §8.2 C5）。[B2][W5-H1]
 *
 * - 无 `contextWindow` 或配置关闭 → 自动压缩关闭（手动 /compact 仍可用）。
 * - 不再限制「每 run 档二 ≤ 1 次」（单提示长任务需要多次摘要）；改为两种跳闸：
 *   - 连续 3 次摘要失败；
 *   - 快速回填：连续 3 次摘要都在上一次摘要后不到 3 回合就又需要摘要（压缩不动、越压越满）。
 *   跳闸后关闭自动压缩直到 `reset()`（例如用户手动压缩成功）。
 * - 固定前缀（system + 工具表）已超过预算：摘要无济于事，直接告警、不再尝试（`prefix_overflow`，
 *   由调用方每次检查时更新）。
 * - 「nothing to compact」不计失败（调用方不调 `recordSummary`）。
 * - 溢出恢复：压缩后估算仍 > 0.8 × window → 不重试。
 */

export const MAX_CONSECUTIVE_FAILURES = 3;
/** 上一次摘要后不到这么多回合又需要摘要，记一次快速回填。 */
export const RAPID_REFILL_TURNS = 3;
export const MAX_RAPID_REFILLS = 3;
export const RETRY_AFTER_COMPACTION_RATIO = 0.8;

export type BreakerBlockReason =
  "disabled" | "no_window" | "tripped" | "rapid_refill" | "prefix_overflow";

export class CompactionBreaker {
  private consecutiveFailures = 0;
  private rapidRefills = 0;
  private turn = 0;
  private lastSummaryTurn: number | undefined;
  private prefixOverflow = false;
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

  /** 连续失败或快速回填跳闸（溢出恢复也不再尝试）。 */
  get tripped(): boolean {
    return (
      this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES || this.rapidRefills >= MAX_RAPID_REFILLS
    );
  }

  /** 自动压缩整体是否开启。 */
  get autoEnabled(): boolean {
    return this.enabled && this.contextWindow !== undefined && !this.tripped;
  }

  /** 新 run 开始（会话在 agent_start 时调用）；不再重置任何计数，保留以兼容调用点。 */
  startRun(): void {}

  /** 每次请求前的阈值检查调用一次：回合计数（快速回填按它判断）。 */
  tick(): void {
    this.turn++;
  }

  /** 固定前缀是否已超预算（调用方每次准备摘要前更新）。 */
  setPrefixOverflow(overflow: boolean): void {
    this.prefixOverflow = overflow;
  }

  /** 自动档二能否执行；不能则给出原因。 */
  blockReason(): BreakerBlockReason | undefined {
    if (!this.enabled) return "disabled";
    if (this.contextWindow === undefined) return "no_window";
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return "tripped";
    if (this.rapidRefills >= MAX_RAPID_REFILLS) return "rapid_refill";
    if (this.prefixOverflow) return "prefix_overflow";
    return undefined;
  }

  canSummarize(): boolean {
    return this.blockReason() === undefined;
  }

  recordSummary(success: boolean): void {
    if (!success) {
      this.consecutiveFailures++;
      return;
    }
    this.consecutiveFailures = 0;
    const last = this.lastSummaryTurn;
    if (last !== undefined && this.turn - last < RAPID_REFILL_TURNS) this.rapidRefills++;
    else this.rapidRefills = 0;
    this.lastSummaryTurn = this.turn;
  }

  /** 手动压缩成功等场景：清零全部计数。 */
  reset(): void {
    this.consecutiveFailures = 0;
    this.rapidRefills = 0;
    this.lastSummaryTurn = undefined;
  }

  /** 溢出恢复后是否值得重试。 */
  shouldRetryAfterCompaction(tokensAfter: number): boolean {
    if (this.contextWindow === undefined) return false;
    return tokensAfter <= RETRY_AFTER_COMPACTION_RATIO * this.contextWindow;
  }
}
