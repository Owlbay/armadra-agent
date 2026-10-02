/**
 * 轨迹构建器的汇总小工具（`build.ts` 用；单独成文件以守住 600 行上限）。[W6-T1]
 */

import type { Usage } from "../ai/types.js";
import type { TraceNodeStatus, TraceTotals } from "./types.js";

/** 汇总累加器：`finishTotals` 转成 `TraceTotals`。 */
export interface TotalsAcc {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  toolCalls: number;
  costSum: number;
  costed: number;
  /** 精确 step 的 ttft 样本。 */
  ttfts: number[];
  /** 精确 step 的 Σoutput 与 Σ(doneAt − firstTokenAt)。 */
  tpsOutput: number;
  tpsMs: number;
  durationMs?: number;
}

export function emptyTotals(): TotalsAcc {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCalls: 0,
    costSum: 0,
    costed: 0,
    ttfts: [],
    tpsOutput: 0,
    tpsMs: 0,
  };
}

/** 计一次请求（进行中的 step 不计：用量还没有）。 */
export function accumulate(
  acc: TotalsAcc,
  node: {
    usage?: Usage | undefined;
    status?: TraceNodeStatus;
    approx?: boolean;
    ttftMs?: number;
    firstTokenAt?: number;
    doneAt?: number;
  },
): void {
  const usage = node.usage;
  if (usage === undefined || node.status === "running") return;
  acc.requests++;
  acc.input += usage.input;
  acc.output += usage.output;
  acc.cacheRead += usage.cacheRead;
  acc.cacheWrite += usage.cacheWrite;
  if (usage.cost !== undefined) {
    acc.costSum += usage.cost.total;
    acc.costed++;
  }
  if (node.approx === true) return;
  if (node.ttftMs !== undefined) acc.ttfts.push(node.ttftMs);
  if (
    node.firstTokenAt !== undefined &&
    node.doneAt !== undefined &&
    node.doneAt > node.firstTokenAt &&
    usage.output > 0
  ) {
    acc.tpsOutput += usage.output;
    acc.tpsMs += node.doneAt - node.firstTokenAt;
  }
}

/** 最近秩分位（确定性；空样本 undefined）。 */
export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

export function finishTotals(acc: TotalsAcc): TraceTotals {
  const totals: TraceTotals = {
    requests: acc.requests,
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    toolCalls: acc.toolCalls,
  };
  if (acc.costed > 0) totals.cost = acc.costSum;
  if (acc.durationMs !== undefined) totals.durationMs = acc.durationMs;
  const sorted = [...acc.ttfts].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  if (p50 !== undefined) totals.ttftP50 = p50;
  if (p90 !== undefined) totals.ttftP90 = p90;
  if (acc.tpsMs > 0) totals.avgTps = Math.round((acc.tpsOutput / (acc.tpsMs / 1000)) * 10) / 10;
  const prompt = acc.input + acc.cacheRead + acc.cacheWrite;
  if (prompt > 0) totals.cacheHitRatio = acc.cacheRead / prompt;
  return totals;
}

export function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * `ama.task` 的 status → 节点状态。文件里的 `running`：有 live 叠加（会话在本进程运行）时仍是 running，
 * 否则视为 `interrupted`（与 resume 重建任务表同一口径）。
 */
export function statusOfTask(status: unknown, live: boolean): TraceNodeStatus {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
    case "max_turns":
      return "error";
    case "aborted":
      return "aborted";
    case "interrupted":
      return "interrupted";
    case "running":
      return live ? "running" : "interrupted";
    default:
      return "ok";
  }
}

/** 把 `from` 的计数并进 `into`（含 ttft 样本）。 */
export function mergeTotals(into: TotalsAcc, from: TotalsAcc): void {
  into.requests += from.requests;
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.toolCalls += from.toolCalls;
  into.costSum += from.costSum;
  into.costed += from.costed;
  into.ttfts.push(...from.ttfts);
  into.tpsOutput += from.tpsOutput;
  into.tpsMs += from.tpsMs;
}
