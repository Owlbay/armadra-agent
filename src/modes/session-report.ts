/**
 * 会话报告与缓存提示文本（第三波 §1.10）。[W3-C2]
 *
 * line 模式、交互模式与 RPC 共用的纯文本层，不含渲染：
 * - `/session`：会话、模型、消息、累计用量、上下文（估算值带 `≈`，末尾是距自动压缩的余量）+ 「缓存」段
 *   （`describeSession`）；
 * - `/cache`：只有缓存段（`describeCache`）；`/cache fingerprint`：最近一次真实请求的前缀指纹；
 * - 消息区 / stderr 的一行提示：缓存未命中（只提示 ≥ 20k token 或 ≥ $0.10 的那次）、
 *   上下文跨越 70% / 90%（`cache.missNotices` 为 false 时都不提示，统计不受影响）。
 *
 * 两列对齐用 B9a-2 的 `KeyValue`（按足够宽的宽度渲染再去行尾空白，结果是纯文本）。
 */

import { AgentSessionImpl } from "../agent/session.js";
import type {
  AgentSession,
  SessionCacheStats,
  SessionEvent,
  SessionStats,
} from "../agent/types.js";
import type {
  CacheMiss,
  CacheMissReason,
  CacheReporting,
  WarmerStatus,
} from "../ai/cache/types.js";
import { MISS_NOTICE_TOKENS, MISS_NOTICE_USD } from "../ai/cache/miss.js";
import { KeyValue, type KeyValueRow } from "../tui/components/key-value.js";
import { quotaParts } from "../auth/chatgpt/quota-text.js";
import { msg } from "../i18n/index.js";

const REPORT_WIDTH = 240;

/** `950`、`38.2k`、`150k`、`1.05M`（比状态栏多一位精度，面板与提示用）。 */
export function formatTokenCount(count: number): string {
  const trim = (text: string): string => text.replace(/\.?0+$/, "");
  if (count < 1000) return String(Math.round(count));
  if (count < 100_000) return `${trim((count / 1000).toFixed(1))}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${trim((count / 1_000_000).toFixed(2))}M`;
}

/** 上下文量不是来自 usage（压缩后新 usage 之前的全量估算、第一次请求前的前缀基线）。 */
export function contextEstimated(stats: Pick<SessionStats, "context">): boolean {
  const source = stats.context?.source;
  return source !== undefined && source !== "usage";
}

/**
 * 上下文行末尾的自动压缩说明：`距自动压缩 ≈ N`（到档二阈值还差多少）；自动压缩关闭或熔断时
 * `自动压缩关闭`；窗口未知或统计没有 `context` 明细时 undefined。
 */
export function autoCompactText(
  stats: Pick<SessionStats, "context" | "contextTokens" | "contextWindow">,
): string | undefined {
  const m = msg().report.session;
  if (stats.context === undefined || stats.contextWindow === undefined) return undefined;
  const at = stats.context.autoCompactAt;
  if (at === undefined) return m.autoCompactOff;
  return m.toAutoCompact(formatTokenCount(Math.max(0, at - (stats.contextTokens ?? 0))));
}

export function formatUsd(cost: number | undefined): string {
  if (cost === undefined) return "$?";
  return cost >= 0.01 || cost === 0 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(3)}`;
}

export function formatPercent(rate: number | undefined): string {
  return rate === undefined ? "—" : `${Math.round(rate * 100)}%`;
}

/** `45s`、`2m 10s`、`7 分钟`（≥ 10 分钟只到分钟）。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 10) return `${minutes}m`;
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function reportingLabel(reporting: CacheReporting): string {
  const m = msg().report.cache;
  return reporting === "reported" ? "reported" : reporting === "silent" ? m.unreported : m.unknown;
}

/** 未命中原因的短语（提示行括号里那段）。 */
export function missReasonText(miss: Pick<CacheMiss, "reason" | "detail" | "idleMs">): string {
  const minutes = Math.max(1, Math.round(miss.idleMs / 60_000));
  const m = msg().report.cache;
  switch (miss.reason) {
    case "idle":
      return m.missIdle(minutes);
    case "subtask":
      return m.missSubtask(minutes);
    case "model_changed":
      return m.missModel;
    case "prefix_changed":
      if (miss.detail === "tools") return m.missTools;
      if (miss.detail === "system") return m.missSystem;
      if (miss.detail?.startsWith("system:") === true)
        return m.missSystemSections(miss.detail.slice("system:".length).replaceAll(",", ", "));
      return m.missPrefix;
    case "evicted":
      return m.missEvicted;
  }
}

export function shouldNotifyMiss(miss: Pick<CacheMiss, "missedTokens" | "missedCost">): boolean {
  return (
    miss.missedTokens >= MISS_NOTICE_TOKENS ||
    (miss.missedCost !== undefined && miss.missedCost >= MISS_NOTICE_USD)
  );
}

/** `缓存未命中（空闲 7 分钟后）：重计费 38.2k token（约 $0.11）`。 */
export function cacheMissNotice(miss: CacheMiss): string {
  return msg().report.cache.missNotice(
    missReasonText(miss),
    formatTokenCount(miss.missedTokens),
    miss.missedCost === undefined ? undefined : formatUsd(miss.missedCost),
  );
}

/** `上下文已用 72%，约剩 9 回合（按最近 5 回合均值）`；估不出回合时给余量 token。 */
export function contextPressureNotice(
  event: Extract<SessionEvent, { type: "context_pressure" }>,
): string {
  const m = msg().report.cache;
  const percent = Math.round(event.percent);
  if (event.estimatedTurnsLeft !== undefined)
    return m.pressureTurns(percent, event.estimatedTurnsLeft);
  if (event.remainingTokens !== undefined)
    return m.pressureTokens(percent, formatTokenCount(event.remainingTokens));
  return m.pressure(percent);
}

/**
 * 缓存事件 → 消息区 / stderr 的一行提示；不提示时 undefined。`enabled` = `cache.missNotices`。
 * 未命中只提示超过门槛的那次；70% 为 warn、90% 为 error；保温事件不进消息区（状态栏 ♨）。
 */
export function cacheEventNotice(
  event: SessionEvent,
  enabled: boolean,
): { level: "warn" | "error"; text: string } | undefined {
  if (!enabled) return undefined;
  if (event.type === "cache_miss") {
    const { type: _type, ...miss } = event;
    return shouldNotifyMiss(miss) ? { level: "warn", text: cacheMissNotice(miss) } : undefined;
  }
  if (event.type === "context_pressure") {
    return { level: event.threshold >= 90 ? "error" : "warn", text: contextPressureNotice(event) };
  }
  return undefined;
}

/** 保温请求发出后的一行（line 模式只在 `AMA_LOG=info|debug` 时写 stderr）。 */
export function warmSentNotice(
  event: Extract<SessionEvent, { type: "cache_warm" }>,
): string | undefined {
  if (event.phase !== "sent") return undefined;
  return msg().report.cache.warmSent(
    event.usage === undefined ? undefined : formatTokenCount(event.usage.cacheRead),
    event.cost === undefined ? undefined : formatUsd(event.cost),
  );
}

/** 消息区 / stderr 是否提示未命中与上下文余量（`cache.missNotices`，缺省 true）。 */
export function cacheNoticesEnabled(session: AgentSession): boolean {
  return session instanceof AgentSessionImpl ? session.cache.cacheSettings.missNotices : true;
}

export function warmStopText(reason: string | undefined): string {
  const m = msg().report.cache;
  if (reason === undefined) return m.stopped;
  return m.stoppedWith(m.stopReason(reason));
}

/** `streaming · 下次 2m 10s · 期望节省 $0.18 ≥ $0.05 · 已发 2 次 $0.01`。 */
export function warmingText(
  status: WarmerStatus,
  now: number,
  minSavingsUsd: number | undefined,
): string {
  if (status.mode === "off") return "off";
  const m = msg().report.cache;
  const parts: string[] = [status.mode];
  if (status.state === "scheduled") {
    if (status.nextWarmAt !== undefined)
      parts.push(m.next(formatDuration(status.nextWarmAt - now)));
    if (status.expectedSavingsUsd !== undefined) {
      const floor = minSavingsUsd === undefined ? undefined : formatUsd(minSavingsUsd);
      parts.push(m.savings(formatUsd(status.expectedSavingsUsd), floor));
    }
  } else if (status.state === "stopped") parts.push(warmStopText(status.reason));
  else parts.push(m.pending);
  if (status.sent !== undefined && status.sent > 0)
    parts.push(m.sent(status.sent, formatUsd(status.costUsd)));
  return parts.join(" · ");
}

function missesText(cache: SessionCacheStats): string {
  const m = msg().report.cache;
  if (cache.misses.count === 0) return m.missesNone;
  const by = Object.entries(cache.misses.byReason)
    .filter(([, n]) => n !== undefined && n > 0)
    .map(([reason, n]) => `${m.reason(reason as CacheMissReason) ?? reason} ${n}`)
    .join(" · ");
  const cost = cache.reBilledUsd === undefined ? "$?" : formatUsd(cache.reBilledUsd);
  return m.misses(cache.misses.count, formatTokenCount(cache.reBilledTokens), cost, by);
}

/** 缓存段的键值行（`/session` 与 `/cache` 共用）。 */
export function cacheRows(session: AgentSession, now: number = Date.now()): KeyValueRow[] {
  const stats = session.getStats();
  const t = stats.tokens;
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  const uncached = t.input + t.cacheWrite;
  const m = msg().report.cache;
  const rows: KeyValueRow[] = [
    {
      key: m.keyInput,
      value: m.input(
        formatTokenCount(prompt),
        formatTokenCount(t.cacheRead),
        prompt > 0 ? formatPercent(t.cacheRead / prompt) : undefined,
        formatTokenCount(uncached),
        t.cacheWrite > 0 ? formatTokenCount(t.cacheWrite) : undefined,
      ),
    },
  ];
  const cache = stats.cache;
  if (cache === undefined) {
    rows.push({ key: m.keyHitRate, value: m.sessionRate(formatPercent(stats.cacheHitRate)) });
    return rows;
  }
  rows.push({ key: m.keyReporting, value: reportingLabel(cache.reporting) });
  if (cache.reporting === "reported") {
    rows.push({
      key: m.keyHitRate,
      value: m.rates(formatPercent(cache.lastHitRate), formatPercent(cache.hitRate)),
    });
  }
  rows.push({ key: m.keyMisses, value: missesText(cache) });
  const minSavings =
    session instanceof AgentSessionImpl ? session.cache.cacheSettings.minSavingsUsd : undefined;
  rows.push({ key: m.keyWarming, value: warmingText(cache.warming, now, minSavings) });
  if (stats.contextPercent !== undefined) {
    rows.push({
      key: m.keyContext,
      value: m.context(
        Math.round(stats.contextPercent),
        cache.contextRemainingTokens === undefined
          ? undefined
          : formatTokenCount(cache.contextRemainingTokens),
        cache.estimatedTurnsLeft,
      ),
    });
  }
  if (cache.subagents !== undefined) {
    const sub = cache.subagents;
    rows.push({
      key: m.keySubtasks,
      value: m.subtasks(
        sub.count,
        formatPercent(sub.hitRate),
        sub.reBilledTokens > 0 ? formatTokenCount(sub.reBilledTokens) : undefined,
      ),
    });
  }
  return rows;
}

/** [W5-U] 外部 Agent 用量一项：美元 / token / 请求数按各自单位，不换算。 */
export function externalUsageText(usage: {
  runs: number;
  unit: "usd" | "tokens" | "requests";
  amount: number;
  tokens?: number;
}): string {
  const m = msg().report.session;
  const amount =
    usage.unit === "usd"
      ? formatUsd(usage.amount)
      : usage.unit === "tokens"
        ? m.externalTokens(formatTokenCount(usage.amount))
        : m.externalRequests(usage.amount);
  const tokens =
    usage.unit !== "tokens" && usage.tokens !== undefined && usage.tokens > 0
      ? formatTokenCount(usage.tokens)
      : undefined;
  return m.external(usage.runs, amount, tokens);
}

/** [W5-U] 「外部 Agent」段（`getStats().external.byAgent`）；没有外部运行时为空。 */
export function externalRows(session: AgentSession): KeyValueRow[] {
  const byAgent = session.getStats().external?.byAgent ?? {};
  return Object.entries(byAgent)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, usage]) => ({ key: agent, value: externalUsageText(usage) }));
}

/** [W5-U] 子 Agent 任务汇总（`getStats().tasks`）；没有任务时 undefined。 */
export function taskStatsText(session: AgentSession): string | undefined {
  const tasks = session.getStats().tasks;
  if (tasks === undefined || tasks.total === 0) return undefined;
  const m = msg().report.session;
  const parts = [m.tasks(tasks.total)];
  if (tasks.running > 0) parts.push(m.running(tasks.running));
  for (const [status, count] of Object.entries(tasks.byStatus))
    if (count !== undefined && count > 0) parts.push(m.status(status, count));
  return m.tasksLine(parts);
}

/** [W6-O] 「订阅用量」段（`getStats().subscription`）：按供应商列请求与 token、缓存只给命中率；附最近配额。 */
export function subscriptionRows(session: AgentSession, now: number = Date.now()): KeyValueRow[] {
  const sub = session.getStats().subscription;
  if (sub === undefined) return [];
  const m = msg().auth.report;
  const rows: KeyValueRow[] = Object.entries(sub.byProvider)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, u]) => {
      const prompt = u.input + u.cacheRead;
      return {
        key: provider,
        value: m.row(
          u.requests,
          formatTokenCount(u.input),
          formatTokenCount(u.output),
          formatTokenCount(u.cacheRead),
          formatPercent(prompt > 0 ? u.cacheRead / prompt : undefined),
        ),
      };
    });
  const quota = sub.quota === undefined ? undefined : quotaParts(sub.quota, now);
  if (quota !== undefined) rows.push({ key: m.quotaKey, value: quota });
  return rows;
}

/** 键值行 → 纯文本（键列对齐、去行尾空白）。 */
export function renderRows(rows: readonly KeyValueRow[], indent = ""): string[] {
  return new KeyValue(rows)
    .render(REPORT_WIDTH)
    .map((line) => (line === "" ? "" : `${indent}${line}`.replace(/\s+$/, "")));
}

export function describeCache(session: AgentSession, now: number = Date.now()): string {
  return [msg().report.cache.title, ...renderRows(cacheRows(session, now), "  ")].join("\n");
}

export function describeSession(session: AgentSession, now: number = Date.now()): string {
  const state = session.state;
  const stats = session.getStats();
  const model = state.model === undefined ? "?" : `${state.model.provider}/${state.model.id}`;
  const t = stats.tokens;
  const percent = stats.contextPercent === undefined ? "?" : `${Math.round(stats.contextPercent)}`;
  const m = msg().report.session;
  const rows: KeyValueRow[] = [
    { key: m.keySession, value: m.session(state.sessionId, state.sessionFile) },
    {
      key: m.keyModel,
      value: m.model(model, state.thinkingLevel, state.permissionMode),
    },
    {
      key: m.keyMessages,
      value: m.messages(stats.userMessages, stats.assistantMessages, stats.toolCalls),
    },
    {
      key: m.keyUsage,
      value: m.usage(
        t.input,
        t.output,
        t.cacheRead,
        t.cacheWrite,
        stats.cost !== undefined ? `$${stats.cost.toFixed(4)}` : "$?",
      ),
    },
    {
      key: m.keyContext,
      value: [
        m.context(
          `${contextEstimated(stats) ? "≈" : ""}${stats.contextTokens ?? "?"}`,
          String(stats.contextWindow ?? "?"),
          percent,
        ),
        autoCompactText(stats),
      ]
        .filter((part) => part !== undefined)
        .join(" · "),
    },
  ];
  const tasks = taskStatsText(session);
  if (tasks !== undefined) rows.push({ key: m.keyAgents, value: tasks });
  const external = externalRows(session);
  const subscription = subscriptionRows(session, now);
  return [
    ...renderRows(rows),
    describeCache(session, now),
    ...(subscription.length > 0
      ? [msg().auth.report.section, ...renderRows(subscription, "  ")]
      : []),
    ...(external.length > 0 ? [m.externalTitle, ...renderRows(external, "  ")] : []),
  ].join("\n");
}

/** `/cache fingerprint`：最近一次真实请求的前缀指纹（system / tools 哈希与模型；[ME-B] 再逐节列哈希）。 */
export function describeFingerprint(session: AgentSession): string {
  const m = msg().report.session;
  if (!(session instanceof AgentSessionImpl)) return m.noFingerprint;
  const record = session.cache.lastTurn;
  if (record === undefined) return m.noRequestYet;
  const f = record.fingerprint;
  return [
    m.fingerprintTitle,
    ...renderRows(
      [
        { key: "system", value: f.system },
        ...Object.entries(f.sections ?? {}).map(([name, hash]) => ({
          key: `  ${name}`,
          value: hash,
        })),
        { key: "tools", value: f.tools },
        { key: "model", value: f.model },
      ],
      "  ",
    ),
  ].join("\n");
}
