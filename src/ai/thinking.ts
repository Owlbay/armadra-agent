/**
 * 思考级别（设计 §3.6「思考」）：用户面 off / minimal / low / medium / high / xhigh。
 *
 * - `getSupportedLevels(model)`：非推理模型只有 off；`thinkingLevelMap[level] === null` 的级别
 *   不支持；`xhigh` 只有在映射表里显式给出时才支持。
 * - `clampThinkingLevel`：不支持的级别先向上找、再向下找最近的可用级别。
 * - 预算型缺省：minimal 1024 / low 2048 / medium 8192 / high 16384（xhigh 按 high）；
 *   与回答共享 max_tokens 时至少给回答留 1024。
 */

import type { Model, ModelThinkingLevel, ThinkingLevel } from "./types.js";

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const DEFAULT_THINKING_BUDGETS: Readonly<Record<ThinkingLevel, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 16384,
};

/** 与回答共享 max_tokens 时留给回答的最少 token。 */
export const MIN_ANSWER_TOKENS = 1024;

export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

type ThinkingModel = Pick<Model, "reasoning" | "thinkingLevelMap">;

export function getSupportedLevels(model: ThinkingModel): ModelThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

export function clampThinkingLevel(
  model: ThinkingModel,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const supported = getSupportedLevels(model);
  if (supported.includes(level)) return level;
  const index = THINKING_LEVELS.indexOf(level);
  for (let i = index + 1; i < THINKING_LEVELS.length; i++) {
    const candidate = THINKING_LEVELS[i];
    if (candidate !== undefined && supported.includes(candidate)) return candidate;
  }
  for (let i = index - 1; i >= 0; i--) {
    const candidate = THINKING_LEVELS[i];
    if (candidate !== undefined && supported.includes(candidate)) return candidate;
  }
  return supported[0] ?? "off";
}

/** 级别在映射表里的供应商原生值；未映射返回 undefined（调用方按协议缺省处理）。 */
export function mappedThinkingValue(
  model: ThinkingModel,
  level: ModelThinkingLevel,
): string | number | undefined {
  const mapped = model.thinkingLevelMap?.[level];
  return mapped === null ? undefined : mapped;
}

/** 预算：映射表给数字就用数字，否则按缺省表。 */
export function thinkingBudget(model: ThinkingModel, level: ThinkingLevel): number {
  const mapped = model.thinkingLevelMap?.[level];
  return typeof mapped === "number" ? mapped : DEFAULT_THINKING_BUDGETS[level];
}

/** 预算不超过 `ceiling - MIN_ANSWER_TOKENS`（不足时为 0）。 */
export function clampBudgetToAnswerRoom(budget: number, ceiling: number): number {
  return Math.min(budget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

/**
 * 预算型思考（Anthropic 老模型）：budget 计入 max_tokens。`requested` 是调用方要的回答上限
 * （缺省 = 模型上限）；返回值 maxTokens ≤ model.maxTokens，budget < maxTokens；budget < 1024 时调用方应关闭思考（Anthropic 下限）。
 */
export function budgetedMaxTokens(
  modelMaxTokens: number,
  requested: number | undefined,
  budget: number,
): { maxTokens: number; budget: number } {
  const maxTokens =
    requested === undefined ? modelMaxTokens : Math.min(requested + budget, modelMaxTokens);
  let adjusted = budget;
  if (maxTokens <= adjusted) adjusted = clampBudgetToAnswerRoom(adjusted, maxTokens);
  return { maxTokens, budget: Math.max(0, Math.min(adjusted, maxTokens - 1)) };
}

/** 解析请求级别：缺省 off；钳位到模型支持的级别。 */
export function resolveThinkingLevel(
  model: ThinkingModel,
  level: ModelThinkingLevel | undefined,
): ModelThinkingLevel {
  return clampThinkingLevel(model, level ?? "off");
}
