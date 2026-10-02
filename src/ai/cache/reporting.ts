/**
 * 「供应商不报缓存」三态（第三波 §1.6）。[W3-C1b]
 *
 * 按 `(provider, baseUrl 主机名, model)` 维护 `unknown | reported | silent`：
 * - 出现过 `cacheRead > 0` 或 `cacheWrite > 0` → `reported`（之后一直是）；
 * - 连续 K = 3 票 → `silent`；一票 = 前缀 ≥ minTokens 且读写都为 0，并且满足其一：
 *   原始响应里**没有**缓存字段（`cacheReported === false`）；或与上一条可比（指纹未变、
 *   间隔 < ttl）——有些中转总塞 `cached_tokens: 0`，单看字段存在不够；
 * - 其余情形（小请求、不可比）既不投票也不清零。`silent` 之后出现命中即转 `reported`。
 * `compat.cacheReporting` 为 `silent` / `reported` 时强制。状态只在内存：进程内跨会话复用
 * （`sharedCacheReporting`），同一端点换会话不必再探 3 次。
 */

import type { CacheReportingSetting } from "../types.js";
import { IMPLICIT_CACHE_TTL_MS } from "./miss.js";
import type { CacheReporting, PrefixFingerprint, RequestRecord } from "./types.js";

/** 连续这么多票判 silent。 */
export const SILENT_STREAK = 3;

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function endpointKey(record: Pick<RequestRecord, "model" | "baseUrl">): string {
  return `${record.model.provider}|${hostOf(record.baseUrl)}|${record.model.id}`;
}

function sameFingerprint(a: PrefixFingerprint, b: PrefixFingerprint): boolean {
  return a.system === b.system && a.tools === b.tools && a.model === b.model;
}

function forced(setting: CacheReportingSetting | undefined): CacheReporting | undefined {
  return setting === "silent" || setting === "reported" ? setting : undefined;
}

interface EndpointState {
  state: CacheReporting;
  streak: number;
  last: RequestRecord | undefined;
}

export class CacheReportingTracker {
  private readonly endpoints = new Map<string, EndpointState>();

  /** 记一条真实请求，返回该端点（含强制设置后）的状态。 */
  observe(
    record: RequestRecord,
    minTokens: number,
    ttlMs?: number,
    setting?: CacheReportingSetting,
  ): CacheReporting {
    const key = endpointKey(record);
    const entry = this.endpoints.get(key) ?? { state: "unknown", streak: 0, last: undefined };
    this.endpoints.set(key, entry);
    const last = entry.last;
    entry.last = record;
    const { cacheRead, cacheWrite, cacheReported } = record.usage;
    if (cacheRead + cacheWrite > 0) {
      entry.state = "reported";
      entry.streak = 0;
    } else if (entry.state !== "reported" && record.promptTokens >= minTokens) {
      const comparable =
        last !== undefined &&
        last.promptTokens >= minTokens &&
        sameFingerprint(last.fingerprint, record.fingerprint) &&
        record.at - last.at < (ttlMs ?? IMPLICIT_CACHE_TTL_MS);
      if (cacheReported === false || comparable) entry.streak++;
      if (entry.streak >= SILENT_STREAK) entry.state = "silent";
    }
    return forced(setting) ?? entry.state;
  }

  get(key: string, setting?: CacheReportingSetting): CacheReporting {
    return forced(setting) ?? this.endpoints.get(key)?.state ?? "unknown";
  }

  /** 测试用：清空全部端点。 */
  clear(): void {
    this.endpoints.clear();
  }
}

/** 进程内共享（同一端点换会话、子会话都复用）。 */
export const sharedCacheReporting = new CacheReportingTracker();
