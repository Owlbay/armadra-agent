/**
 * `ama stats` 的汇总（纯函数）：文件摘要 → 合计、分组、按来源的请求数、工具 Top N。[W4-D]
 *
 * 口径（与 `/session`、`get_session_stats` 一致）：
 * - 请求 = 每次模型请求（回合里的 assistant、保温、权限分类、压缩摘要…），按 kind 分开计；
 * - 命中率 = cacheRead /（input + cacheRead + cacheWrite），只算「报告缓存」的端点：同一
 *   provider/model@channel 在扫描范围内出现过任何非零缓存读写才算；其余端点不进分母；
 * - 费用只加有价请求；`unpriced` 是无价请求数（全无价时 cost 缺省，展示层只给 token）。
 */

import type { FileStatsSummary, StatsBucket } from "./stats-scan.js";

export const STATS_GROUPS = [
  "day",
  "week",
  "month",
  "provider",
  "channel",
  "model",
  "project",
] as const;
export type StatsGroupBy = (typeof STATS_GROUPS)[number];

export interface StatsTotals {
  requests: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 有价请求的费用；没有任何有价请求时缺省。 */
  cost?: number;
  /** 无价请求数。 */
  unpriced: number;
  /** 0–1；报告缓存的端点没有输入时缺省。 */
  hitRate?: number;
  errors: number;
  retries: number;
  /** 平均回合耗时（毫秒）；没有可计时的回合时缺省。 */
  avgTurnMs?: number;
}

export interface StatsGroup extends StatsTotals {
  key: string;
  sessions: number;
}

export interface StatsReport {
  since?: string;
  until?: string;
  sessions: number;
  totals: StatsTotals;
  /** kind → 请求数。 */
  byKind: Record<string, number>;
  groups?: StatsGroup[];
  tools: Array<{ name: string; count: number }>;
  endpoints: { reported: number; total: number };
}

interface Acc {
  requests: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costed: number;
  hitRead: number;
  hitPrompt: number;
  errors: number;
  retries: number;
  turnMs: number;
  timedTurns: number;
  sessions: Set<string>;
}

const newAcc = (): Acc => ({
  requests: 0,
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  costed: 0,
  hitRead: 0,
  hitPrompt: 0,
  errors: 0,
  retries: 0,
  turnMs: 0,
  timedTurns: 0,
  sessions: new Set(),
});

export function endpointOf(b: Pick<StatsBucket, "provider" | "model" | "channel">): string {
  return `${b.provider}/${b.model}${b.channel !== undefined ? `@${b.channel}` : ""}`;
}

function add(acc: Acc, b: StatsBucket, reported: boolean, session: string): void {
  acc.requests += b.requests;
  acc.turns += b.turns;
  acc.input += b.input;
  acc.output += b.output;
  acc.cacheRead += b.cacheRead;
  acc.cacheWrite += b.cacheWrite;
  acc.cost += b.cost;
  acc.costed += b.costed;
  if (reported) {
    acc.hitRead += b.cacheRead;
    acc.hitPrompt += b.input + b.cacheRead + b.cacheWrite;
  }
  acc.errors += b.errors;
  acc.retries += b.retries;
  acc.turnMs += b.turnMs;
  acc.timedTurns += b.timedTurns;
  acc.sessions.add(session);
}

function totals(acc: Acc): StatsTotals {
  const out: StatsTotals = {
    requests: acc.requests,
    turns: acc.turns,
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    unpriced: acc.requests - acc.costed,
    errors: acc.errors,
    retries: acc.retries,
  };
  if (acc.costed > 0) out.cost = acc.cost;
  if (acc.hitPrompt > 0) out.hitRate = acc.hitRead / acc.hitPrompt;
  if (acc.timedTurns > 0) out.avgTurnMs = acc.turnMs / acc.timedTurns;
  return out;
}

/** 本地日期 → ISO 周 `2026-W40`。 */
export function isoWeek(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${week < 10 ? `0${week}` : week}`;
}

function groupKey(by: StatsGroupBy, b: StatsBucket, cwd: string): string {
  switch (by) {
    case "day":
      return b.day;
    case "week":
      return isoWeek(b.day);
    case "month":
      return b.day.slice(0, 7);
    case "provider":
      return b.provider;
    case "channel":
      return endpointOf(b);
    case "model":
      return `${b.provider}/${b.model}`;
    case "project":
      return cwd;
  }
}

export interface AggregateOptions {
  /** 含当天，本地日期 YYYY-MM-DD。 */
  since?: string;
  until?: string;
  by?: StatsGroupBy;
  /** 工具 Top N（缺省 10）。 */
  topTools?: number;
}

export function aggregateStats(
  summaries: readonly FileStatsSummary[],
  options: AggregateOptions = {},
): StatsReport {
  const inRange = (day: string): boolean =>
    (options.since === undefined || day >= options.since) &&
    (options.until === undefined || day <= options.until);
  const reported = new Set<string>();
  const endpoints = new Set<string>();
  for (const s of summaries)
    for (const b of s.buckets) {
      endpoints.add(endpointOf(b));
      if (b.cacheSeen) reported.add(endpointOf(b));
    }
  const all = newAcc();
  const groups = new Map<string, Acc>();
  const byKind: Record<string, number> = {};
  const tools = new Map<string, number>();
  for (const s of summaries) {
    for (const b of s.buckets) {
      if (!inRange(b.day)) continue;
      const isReported = reported.has(endpointOf(b));
      add(all, b, isReported, s.id);
      byKind[b.kind] = (byKind[b.kind] ?? 0) + b.requests;
      if (options.by !== undefined) {
        const key = groupKey(options.by, b, s.cwd);
        let acc = groups.get(key);
        if (acc === undefined) groups.set(key, (acc = newAcc()));
        add(acc, b, isReported, s.id);
      }
    }
    for (const [day, name, count] of s.tools)
      if (inRange(day)) tools.set(name, (tools.get(name) ?? 0) + count);
  }
  const report: StatsReport = {
    sessions: all.sessions.size,
    totals: totals(all),
    byKind,
    tools: [...tools]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, options.topTools ?? 10),
    endpoints: { reported: reported.size, total: endpoints.size },
  };
  if (options.since !== undefined) report.since = options.since;
  if (options.until !== undefined) report.until = options.until;
  if (options.by !== undefined) {
    const timeOrdered = options.by === "day" || options.by === "week" || options.by === "month";
    report.groups = [...groups]
      .map(([key, acc]) => ({ key, sessions: acc.sessions.size, ...totals(acc) }))
      .sort((a, b) =>
        timeOrdered
          ? a.key.localeCompare(b.key)
          : b.requests - a.requests || a.key.localeCompare(b.key),
      );
  }
  return report;
}
