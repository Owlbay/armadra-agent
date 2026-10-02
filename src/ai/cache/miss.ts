/**
 * 未命中检测（第三波 §1.5）：同一请求链上前后两条 `RequestRecord` 比对，纯函数。[W3-C1b]
 *
 * 1. 不计：没有 prev；本条 promptTokens 为 0；本条读写都为 0 且端点不是 `reported`（§1.6）；
 *    prev 低于最小可缓存长度（判 unknown，不判 miss）。
 * 2. `missed = min(prev, cur) − cur.cacheRead`；`missed ≤ noiseFloor` 不计，
 *    `noiseFloor = max(1024, minTokens)`。
 * 3. 规模自适应：`missed / prev > clamp(0.10 × √(100k / prev), 0.02, 0.30)` 或 `missed ≥ 20k`。
 * 4. 成本：用本条实付反推——`(cost.input + cost.cacheWrite) / (input + cacheWrite)` 减去读价
 *    （本条有读用实付，否则用目录价）；无价格 → `missedCost` 缺省。
 * 5. 重置点（压缩 / 分支摘要 / 档一裁剪之后的首个请求）由调用方清空 prev；模型切换不豁免。
 * 6. 归因：指纹 system / tools 变 → `prefix_changed`；模型变 → `model_changed`；
 *    `idleMs > ttl`（无承诺 TTL 的隐式缓存按 600 s）→ `idle`；task 运行占间隔 ≥ 80% →
 *    `subtask`；其余 → `evicted`。
 */

import type { ModelCost } from "../types.js";
import { fingerprintChange } from "./fingerprint.js";
import type { CacheMiss, CacheReporting, RequestRecord } from "./types.js";

/** 无承诺 TTL 的端点（隐式缓存）按 10 分钟估。 */
export const IMPLICIT_CACHE_TTL_MS = 600_000;
/** 没有目录 `minTokens` 时的最小可缓存长度与噪声下限。 */
export const DEFAULT_MIN_CACHE_TOKENS = 1024;
/** 绝对门槛：一次少读这么多 token 无论比例都算未命中。 */
export const MISS_ABSOLUTE_TOKENS = 20_000;
/** 转录 / 消息区只提示超过这两个门槛之一的未命中（统计计入全部）。 */
export const MISS_NOTICE_TOKENS = 20_000;
export const MISS_NOTICE_USD = 0.1;
/** task 运行时间占间隔的比例达到它 → 归因 subtask。 */
export const SUBTASK_SHARE = 0.8;

export interface MissOptions {
  /** 本条请求所在端点的三态；读写都为 0 时只有 `reported` 才判。 */
  reporting?: CacheReporting;
  /** 目录 `promptCache.minTokens`。 */
  minTokens?: number;
  /** prev 与 cur 之间 task 工具运行的墙钟时间。 */
  subtaskMs?: number;
  /** 本条没有缓存读时的读价来源（目录价）。 */
  cost?: Pick<ModelCost, "cacheRead">;
}

export function noiseFloor(minTokens: number | undefined): number {
  return Math.max(DEFAULT_MIN_CACHE_TOKENS, minTokens ?? DEFAULT_MIN_CACHE_TOKENS);
}

/** 未命中比例门槛：前缀越长越敏感（2%–30%）。 */
export function missRatioThreshold(prevTokens: number): number {
  if (prevTokens <= 0) return 0.3;
  const raw = 0.1 * Math.sqrt(100_000 / prevTokens);
  return Math.min(0.3, Math.max(0.02, raw));
}

/** 重计费金额（美元）；本条无成本 → undefined。 */
export function missedCostOf(
  cur: RequestRecord,
  missed: number,
  cost?: Pick<ModelCost, "cacheRead">,
): number | undefined {
  const { usage } = cur;
  if (usage.cost === undefined) return undefined;
  const paidTokens = usage.input + usage.cacheWrite;
  if (paidTokens <= 0) return 0;
  const paidPerToken = (usage.cost.input + usage.cost.cacheWrite) / paidTokens;
  let readPerToken: number;
  if (usage.cacheRead > 0) readPerToken = usage.cost.cacheRead / usage.cacheRead;
  else if (cost !== undefined) readPerToken = cost.cacheRead / 1e6;
  else return undefined;
  return missed * Math.max(0, paidPerToken - readPerToken);
}

export function detectMiss(
  prev: RequestRecord | undefined,
  cur: RequestRecord,
  ttlMs: number | undefined,
  options: MissOptions = {},
): CacheMiss | undefined {
  if (prev === undefined || cur.promptTokens <= 0) return undefined;
  const { cacheRead, cacheWrite } = cur.usage;
  if (cacheRead + cacheWrite === 0 && options.reporting !== "reported") return undefined;
  const minTokens = options.minTokens ?? DEFAULT_MIN_CACHE_TOKENS;
  if (prev.promptTokens < minTokens) return undefined;

  const missed = Math.min(prev.promptTokens, cur.promptTokens) - cacheRead;
  if (missed <= noiseFloor(options.minTokens)) return undefined;
  const ratio = missed / prev.promptTokens;
  if (ratio <= missRatioThreshold(prev.promptTokens) && missed < MISS_ABSOLUTE_TOKENS) {
    return undefined;
  }

  const idleMs = Math.max(0, cur.at - prev.at);
  const miss: CacheMiss = { missedTokens: missed, reason: "evicted", idleMs };
  const cost = missedCostOf(cur, missed, options.cost);
  if (cost !== undefined) miss.missedCost = cost;

  const change = fingerprintChange(prev.fingerprint, cur.fingerprint);
  if (change === "system" || change === "tools") {
    miss.reason = "prefix_changed";
    miss.detail = change;
  } else if (change === "model") miss.reason = "model_changed";
  else if (idleMs > (ttlMs ?? IMPLICIT_CACHE_TTL_MS)) miss.reason = "idle";
  else if (idleMs > 0 && (options.subtaskMs ?? 0) >= SUBTASK_SHARE * idleMs) {
    miss.reason = "subtask";
  }
  return miss;
}

/** 转录 / 消息区是否提示这次未命中（`/session` 与 RPC 统计计入全部）。 */
export function isNotableMiss(miss: CacheMiss): boolean {
  return (
    miss.missedTokens >= MISS_NOTICE_TOKENS ||
    (miss.missedCost !== undefined && miss.missedCost >= MISS_NOTICE_USD)
  );
}
