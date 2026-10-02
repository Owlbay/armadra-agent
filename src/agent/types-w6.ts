/**
 * 第六波会话事件与统计（docs/wave6-plan.md §4.4、D17）。[W6-C0] 契约文件：形状在这里，行为由 W6-O 实现。
 */

/** 一档配额窗口的用量。 */
export interface QuotaWindow {
  /** 0–100。 */
  usedPercent: number;
  /** epoch ms。 */
  resetsAt?: number;
  windowMinutes?: number;
}

/**
 * [W6-O] 订阅配额更新：codex flavor 来自 `x-codex-*` 响应头与 `codex.rate_limits` 事件；SIWC 只在 429 时给出。
 * 宿主只消费它与错误码 `auth_expired` / `quota_exceeded`。
 */
export interface QuotaUpdateEvent {
  type: "quota_update";
  provider: string;
  planType?: string;
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
}

export type SessionEventW6 = QuotaUpdateEvent;

/** [W6-O] 订阅计费的请求（`Usage.billing: "subscription"`）：单列，不折算美元。 */
export interface SubscriptionStats {
  requests: number;
  byProvider: Record<
    string,
    { requests: number; input: number; output: number; cacheRead: number }
  >;
  /** [W6-O] 本会话最近一次 `quota_update`（没有收到过时缺省）。 */
  quota?: QuotaUpdateEvent;
}

export interface SessionStatsW6 {
  /** [W6-O] 订阅用量；没有订阅请求时缺省。 */
  subscription?: SubscriptionStats;
}
