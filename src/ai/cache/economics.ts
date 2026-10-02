/**
 * 保温经济性（第三波 §1.7「经济性」）。[W3-C1b]
 *
 * P = 上一次真实请求的 input + cacheRead + cacheWrite：
 * - `hitCost = price({cacheRead: P})`
 * - `missCost = price(cacheWrite 价 > 0 ? {cacheWrite: P} : {input: P}) − hitCost`
 * - `warmCost = price({cacheRead: P, output: 1})`
 * - 概率 p：streaming 1、idle 0.15；`p·missCost − warmCost ≥ minSavingsUsd` 才发。
 * 无价格或价格全为 0 → 「经济性不可算」，不发（reason `no_price`）。
 *
 * 计价用 `src/ai/cost.ts` 的 `priceTokens`（与 calculateCost 同一套阶梯与 1h 写入规则）。
 */

import { priceTokens } from "../cost.js";
import type { Model, Usage } from "../types.js";
import type { WarmDecision, WarmingPhase } from "./types.js";

export const WARM_PROBABILITY: Readonly<Record<WarmingPhase, number>> = {
  streaming: 1,
  idle: 0.15,
};

export { priceTokens };

function priced(model: Pick<Model, "cost">): boolean {
  const cost = model.cost;
  return cost !== undefined && (cost.input > 0 || cost.cacheWrite > 0);
}

export function evaluateWarm(
  model: Pick<Model, "cost">,
  promptTokens: number,
  phase: WarmingPhase,
  minSavingsUsd: number,
): WarmDecision {
  const probability = WARM_PROBABILITY[phase];
  const decision: WarmDecision = {
    action: "stop",
    phase,
    promptTokens,
    warmCost: undefined,
    missCost: undefined,
    probability,
  };
  if (!priced(model)) {
    decision.reason = "no_price";
    return decision;
  }
  const P = promptTokens;
  const writes = (model.cost?.cacheWrite ?? 0) > 0;
  const hit = priceTokens(model, { cacheRead: P }) ?? 0;
  const full = priceTokens(model, writes ? { cacheWrite: P } : { input: P }) ?? 0;
  decision.missCost = full - hit;
  decision.warmCost = priceTokens(model, { cacheRead: P, output: 1 }) ?? 0;
  if (probability * decision.missCost - decision.warmCost >= minSavingsUsd)
    decision.action = "warm";
  else decision.reason = "below_min_savings";
  return decision;
}

/** 期望节省（美元）；不可算时 undefined。 */
export function expectedSavings(decision: WarmDecision): number | undefined {
  if (decision.missCost === undefined || decision.warmCost === undefined) return undefined;
  return decision.probability * decision.missCost - decision.warmCost;
}

/**
 * 盈亏点：前缀至少多少 token 保温才划算（不计阶梯价）。永不划算或超过上下文窗口 → undefined。
 */
export function warmBreakEven(
  model: Pick<Model, "cost" | "contextWindow">,
  phase: WarmingPhase,
  minSavingsUsd: number,
): number | undefined {
  const cost = model.cost;
  if (cost === undefined || !priced(model)) return undefined;
  const p = WARM_PROBABILITY[phase];
  const full = cost.cacheWrite > 0 ? cost.cacheWrite : cost.input;
  const perToken = (p * (full - cost.cacheRead) - cost.cacheRead) / 1e6;
  if (perToken <= 0) return undefined;
  const tokens = Math.ceil((minSavingsUsd + cost.output / 1e6) / perToken);
  return model.contextWindow !== undefined && tokens > model.contextWindow ? undefined : tokens;
}
