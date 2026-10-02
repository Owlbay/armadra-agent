/**
 * 成本（设计 §3.6「成本」）：价格单位为美元 / 百万 token。
 *
 * - 阶梯：按 `input + cacheRead + cacheWrite`（本次请求的全部输入）选**严格超过**阈值的最高一档，
 *   整单按该档计价；
 * - `Usage.input` 不含缓存部分；
 * - 1 小时缓存写入（`cacheWrite1h`，已包含在 `cacheWrite` 中）按 2× 基础输入价计；
 * - 模型无 `cost` → 不写 `usage.cost`（界面显示 `$?`）；
 * - `priceTokens` 给假想用量估价（保温经济性、未命中重计费、cache-probe 预估，第三波 §3.2）。
 */

import type { Model, ModelCost, Usage, UsageCost } from "./types.js";

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function selectRates(cost: ModelCost, totalInput: number): Omit<ModelCost, "tiers"> {
  let rates: Omit<ModelCost, "tiers"> = cost;
  let threshold = -1;
  for (const tier of cost.tiers ?? []) {
    if (totalInput > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      rates = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  return rates;
}

/** 计算并写回 `usage.cost`；无价格时删除 `usage.cost` 并返回 undefined。 */
export function calculateCost(model: Pick<Model, "cost">, usage: Usage): UsageCost | undefined {
  if (!model.cost) {
    delete usage.cost;
    return undefined;
  }
  const rates = selectRates(model.cost, usage.input + usage.cacheRead + usage.cacheWrite);
  const longWrite = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite);
  const shortWrite = usage.cacheWrite - longWrite;
  const cost: UsageCost = {
    input: (rates.input * usage.input) / 1e6,
    output: (rates.output * usage.output) / 1e6,
    cacheRead: (rates.cacheRead * usage.cacheRead) / 1e6,
    cacheWrite: (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1e6,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  usage.cost = cost;
  return cost;
}

/**
 * [W3-C1a] 按目录价给一组假想 token 估价（美元）：与 `calculateCost` 同一套阶梯与 1h 写入规则，
 * 缺省字段按 0；模型无 `cost` → undefined（价格为 0 时返回 0，「不可算」由调用方判断）。
 */
export function priceTokens(
  model: Pick<Model, "cost">,
  tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number | undefined {
  if (!model.cost) return undefined;
  const usage: Usage = { ...emptyUsage(), ...tokens };
  return calculateCost(model, usage)?.total;
}

/** 重新计算 totalTokens（各家多数不直接给，或给的口径不同）。 */
export function finalizeUsage(model: Pick<Model, "cost">, usage: Usage): Usage {
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  calculateCost(model, usage);
  return usage;
}
