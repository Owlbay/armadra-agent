/**
 * 会话侧的压缩调度（设计 §9）。[B2]
 *
 * - 阈值检查（新提示前、`prepareNextTurn` 里）：估算 > 0.7 ×（窗口 − 预留）→ 档一裁剪（[W5-H1] 按工具
 *   结果新旧计边界，可省 ≥ clearAtLeast 才动，一次清到 0.5 ×）；仍 > 窗口 − 预留且熔断允许 → 档二摘要
 *   （trigger `threshold`）。缓存已冷（上次请求距今超过 TTL，只认 reported 端点）时未到 0.7 也裁，
 *   且一次换掉全部候选。
 * - 溢出恢复（会话 run 结束后，失败尝试已用 context_edit 剔除）：PreCompact Hook → 档二摘要（trigger
 *   `overflow`，不受「每 run 一次」限制但受跳闸限制）→ 压缩后估算 ≤ 0.8 × 窗口才重试。
 * - 手动 `/compact`：PreCompact（trigger `manual`）→ 摘要；成功清零熔断。
 * PreCompact 的 `decision: "block"` 取消本次压缩；`customInstructions` 追加到摘要提示。
 * [W3-C1b] 阈值 / 手动压缩与分支摘要优先走会话前缀续写（缓存控制器给前缀），溢出恢复不走
 * （前缀本身已超窗口）；续写失败回落独立请求并记 warning。
 */

import { AmaError } from "../errors.js";
import { CompactionBreaker } from "../compaction/breaker.js";
import { estimateProjectedTokens, type ContextEstimate } from "../compaction/estimate.js";
import { planPrune, prunePolicy, type PrunePolicy } from "../compaction/prune-tier.js";
import { createProtection, skillLocations } from "../compaction/protect.js";
import type { CompactionConfig } from "../config/types.js";
import {
  prepareCompaction,
  prepareCompactionAt,
  runCompaction,
  type SummarizerOptions,
} from "../compaction/summarize-tier.js";
import { prepareBranchSummary, runBranchSummary } from "../compaction/branch-summary.js";
import { buildProjection } from "../session/projection.js";
import type { BranchSummaryEntry } from "../session/types.js";
import type { SessionCore } from "./session-core.js";
import type { CompactionResult, CompactionSettings, CompactionTrigger } from "./types.js";

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

/** 保留区不超过 (窗口 − 预留) 的 40%，否则小窗口模型上摘要后仍然溢出。 */
export const KEEP_RECENT_MAX_RATIO = 0.4;

interface SummarizeOutcome {
  result: CompactionResult | undefined;
  tokensAfter: number | undefined;
  error: string | undefined;
  aborted: boolean;
}

export class CompactionController {
  readonly breaker: CompactionBreaker;
  settings: CompactionSettings;
  private readonly core: SessionCore;
  private compacting = false;
  /** [W5-H1] config `compaction.prune / pruneExclude`（组装根把整段 config.compaction 展开传入）。 */
  private readonly pruneConfig: Pick<CompactionConfig, "prune" | "pruneExclude">;

  constructor(core: SessionCore, settings: Partial<CompactionSettings> = {}) {
    this.core = core;
    this.settings = { ...DEFAULT_COMPACTION_SETTINGS, ...settings };
    const extra = settings as CompactionConfig;
    this.pruneConfig = {};
    if (extra.prune !== undefined) this.pruneConfig.prune = extra.prune;
    if (extra.pruneExclude !== undefined) this.pruneConfig.pruneExclude = extra.pruneExclude;
    this.breaker = new CompactionBreaker(this.settings.enabled, core.model().contextWindow);
  }

  get isCompacting(): boolean {
    return this.compacting;
  }

  /** 模型或开关变化后调用。 */
  refresh(): void {
    this.breaker.configure(this.settings.enabled, this.core.model().contextWindow);
  }

  setAuto(enabled: boolean): void {
    this.settings = { ...this.settings, enabled };
    this.refresh();
  }

  estimate(): ContextEstimate {
    const branch = this.core.manager.branch();
    return estimateProjectedTokens(buildProjection(branch).items, branch);
  }

  private budget(): number | undefined {
    const window = this.core.model().contextWindow;
    return window === undefined ? undefined : Math.max(0, window - this.settings.reserveTokens);
  }

  private keepRecent(): number {
    const budget = this.budget();
    if (budget === undefined) return this.settings.keepRecentTokens;
    return Math.max(
      1,
      Math.min(this.settings.keepRecentTokens, Math.floor(budget * KEEP_RECENT_MAX_RATIO)),
    );
  }

  /** 摘要请求的公共选项；`continuation` 时附上会话前缀续写的材料。 */
  private async summarizer(
    signal: AbortSignal,
    instructions: string | undefined,
    continuation: boolean,
  ): Promise<SummarizerOptions> {
    const core = this.core;
    const options: SummarizerOptions = {
      stream: core.stream,
      model: core.model(),
      apiKey: await core.resolveApiKey(),
      signal,
      customInstructions: instructions,
      onFallback: (reason) =>
        core.log(
          "warn",
          `summary by prefix continuation failed (${reason}); used a separate request`,
        ),
    };
    if (continuation) options.continuation = core.cache?.summaryContinuation();
    return options;
  }

  /** 档一参数；无窗口时 undefined。 */
  prunePolicy(): PrunePolicy | undefined {
    const budget = this.budget();
    return budget === undefined ? undefined : prunePolicy(budget, this.pruneConfig.prune);
  }

  /**
   * 档一；`need` = 清到目标还要省多少（undefined = 全部候选）。返回省下的 token 估算（0 = 未裁）。
   */
  prune(policy: PrunePolicy, need: number | undefined): number {
    const core = this.core;
    const items = buildProjection(core.manager.branch()).items;
    const isProtected = createProtection({
      cwd: core.cwd,
      skillPaths: skillLocations(items),
      exclude: this.pruneConfig.pruneExclude ?? [],
      keepInContext: (name) => core.tool(name)?.annotations?.keepInContext === true,
    });
    const plan = planPrune(items, { policy, need, outputDir: core.outputDir(), isProtected });
    for (const item of plan.items) {
      this.core.appendEntry({
        type: "context_edit",
        targetId: item.targetId,
        replacement: item.replacement,
        reason: "prune",
      });
    }
    if (plan.items.length > 0) this.core.reloadMessages();
    return plan.savedTokens;
  }

  /** 阈值检查（档一 → 档二）。失败只记录，不打断 run。 */
  async checkThreshold(signal: AbortSignal): Promise<void> {
    if (!this.breaker.autoEnabled || this.compacting || signal.aborted) return;
    const policy = this.prunePolicy();
    const budget = this.budget();
    if (policy === undefined || budget === undefined) return;
    let tokens = this.estimate().tokens;
    // 缓存已冷（C3）：前缀反正要重写，未到阈值也把候选一次换掉（仍要可省 ≥ clearAtLeast）
    const cold = this.core.cache?.isCold() ?? false;
    if (tokens > policy.triggerTokens || cold) {
      const need = cold ? undefined : tokens - policy.targetTokens;
      if (this.prune(policy, need) > 0) tokens = this.estimate().tokens;
    }
    if (tokens <= budget || !this.breaker.canSummarize()) return;
    await this.summarize("threshold", signal);
  }

  /** 溢出恢复：返回是否应以新 run 重试。 */
  async recoverOverflow(signal: AbortSignal): Promise<{ retry: boolean; warning?: string }> {
    if (!this.settings.enabled)
      return { retry: false, warning: "context overflow: auto-compaction is disabled" };
    if (this.core.model().contextWindow === undefined) {
      return {
        retry: false,
        warning: "context overflow: model has no contextWindow, auto-compaction is off",
      };
    }
    if (this.breaker.tripped) {
      return {
        retry: false,
        warning: "context overflow: auto-compaction disabled after repeated failures",
      };
    }
    const outcome = await this.summarize("overflow", signal);
    if (outcome.result === undefined) {
      if (signal.aborted) return { retry: false };
      return {
        retry: false,
        warning: `context overflow: compaction failed (${outcome.error ?? "unknown"})`,
      };
    }
    if (!this.breaker.shouldRetryAfterCompaction(outcome.tokensAfter ?? Number.POSITIVE_INFINITY)) {
      return {
        retry: false,
        warning: "context overflow: still above 80% of the window after compaction",
      };
    }
    return { retry: true };
  }

  /** `cutAt`：[RW-B] 以该条目为切点（「摘要到这里」），不按保留预算找切点。 */
  async compactManual(
    instructions: string | undefined,
    signal: AbortSignal,
    cutAt?: string,
  ): Promise<CompactionResult> {
    const outcome = await this.summarize("manual", signal, instructions, cutAt);
    if (outcome.result === undefined) {
      if (outcome.aborted) throw new AmaError("aborted", "compaction aborted");
      throw new AmaError("compaction_failed", outcome.error ?? "compaction failed");
    }
    this.breaker.reset();
    return outcome.result;
  }

  /** `/tree` 离开分支：换叶子，并为离开的那段写 branch_summary（挂在新叶子下）。 */
  async leaveBranch(
    targetId: string | null,
    instructions: string | undefined,
    signal: AbortSignal,
  ): Promise<BranchSummaryEntry | undefined> {
    const core = this.core;
    const index = new Map(core.manager.entries().map((entry) => [entry.id, entry]));
    const plan = prepareBranchSummary(index, core.manager.leafId(), targetId);
    core.manager.setLeaf(targetId);
    if (plan === undefined) return undefined;
    const draft = await runBranchSummary(plan, await this.summarizer(signal, instructions, true));
    return core.appendEntry({
      type: "branch_summary",
      fromId: draft.fromId,
      summary: draft.summary,
      usage: draft.usage,
      details: draft.details,
    }) as BranchSummaryEntry;
  }

  private async summarize(
    trigger: CompactionTrigger,
    signal: AbortSignal,
    instructions?: string,
    cutAt?: string,
  ): Promise<SummarizeOutcome> {
    const core = this.core;
    this.compacting = true;
    core.emit({ type: "compaction_start", trigger });
    const end = (outcome: SummarizeOutcome, willRetry: boolean): SummarizeOutcome => {
      const event: Parameters<SessionCore["emit"]>[0] = {
        type: "compaction_end",
        trigger,
        aborted: outcome.aborted,
        willRetry,
      };
      if (outcome.result !== undefined) event.result = outcome.result;
      if (outcome.error !== undefined) event.error = outcome.error;
      core.emit(event);
      this.compacting = false;
      return outcome;
    };
    const fail = (error: string, aborted = false): SummarizeOutcome =>
      end({ result: undefined, tokensAfter: undefined, error, aborted }, false);

    const tokensBefore = this.estimate().tokens;
    let customInstructions = instructions;
    const hook = await core.runHook(
      "PreCompact",
      { tokensBefore, trigger: trigger === "manual" ? "manual" : "auto" },
      signal,
    );
    if (hook !== undefined) {
      if (hook.decision === "block" || hook.decision === "deny") {
        return fail(hook.reason ?? "compaction blocked by PreCompact hook", true);
      }
      if (hook.customInstructions !== undefined) {
        customInstructions = [customInstructions, hook.customInstructions]
          .filter(Boolean)
          .join("\n\n");
      }
    }
    if (signal.aborted) return fail("aborted", true);

    // 保留区按预算切不出可摘要的前缀（单条消息很大）时逐级缩小，最后只保留最近一个切点。
    const projection = buildProjection(core.manager.branch());
    const keep = this.keepRecent();
    let plan: ReturnType<typeof prepareCompaction>;
    if (cutAt !== undefined) plan = prepareCompactionAt(projection, cutAt);
    else {
      for (const budget of [keep, Math.floor(keep / 4), 1]) {
        plan = prepareCompaction(projection, Math.max(1, budget));
        if (plan !== undefined) break;
      }
    }
    if (plan === undefined) {
      if (trigger !== "manual") this.breaker.recordSummary(false);
      return fail("nothing to compact");
    }
    try {
      const options = await this.summarizer(signal, customInstructions, trigger !== "overflow");
      const draft = await runCompaction(plan, options);
      if (signal.aborted) return fail("aborted", true);
      const entry: Parameters<SessionCore["appendEntry"]>[0] = {
        type: "compaction",
        summary: draft.summary,
        firstKeptEntryId: draft.firstKeptEntryId,
        tokensBefore,
        details: draft.details,
      };
      if (draft.usage !== undefined) entry.usage = draft.usage;
      core.appendEntry(entry);
      core.reloadMessages();
      this.breaker.recordSummary(true);
      const tokensAfter = this.estimate().tokens;
      const result: CompactionResult = {
        summary: draft.summary,
        firstKeptEntryId: draft.firstKeptEntryId,
        tokensBefore,
        tokensAfter,
      };
      if (draft.usage !== undefined) result.usage = draft.usage;
      const willRetry =
        trigger === "overflow" && this.breaker.shouldRetryAfterCompaction(tokensAfter);
      return end({ result, tokensAfter, error: undefined, aborted: false }, willRetry);
    } catch (error) {
      const aborted = signal.aborted || (error instanceof AmaError && error.code === "aborted");
      if (!aborted) this.breaker.recordSummary(false);
      return fail(error instanceof Error ? error.message : String(error), aborted);
    }
  }
}
