/**
 * 会话报告与缓存提示文本（第三波 §1.10）。[W3-C2]
 *
 * line 模式、交互模式与 RPC 共用的纯文本层，不含渲染：
 * - `/session`：会话、模型、消息、用量、上下文 + 「缓存」段（`describeSession`）；
 * - `/cache`：只有缓存段（`describeCache`）；`/cache fingerprint`：最近一次真实请求的前缀指纹；
 * - 消息区 / stderr 的一行提示：缓存未命中（只提示 ≥ 20k token 或 ≥ $0.10 的那次）、
 *   上下文跨越 70% / 90%（`cache.missNotices` 为 false 时都不提示，统计不受影响）。
 *
 * 两列对齐用 B9a-2 的 `KeyValue`（按足够宽的宽度渲染再去行尾空白，结果是纯文本）。
 */

import { AgentSessionImpl } from "../agent/session.js";
import type { AgentSession, SessionCacheStats, SessionEvent } from "../agent/types.js";
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
  return reporting === "reported" ? "reported" : reporting === "silent" ? "未报告" : "未知";
}

const REASON_LABELS: Readonly<Record<CacheMissReason, string>> = {
  prefix_changed: "前缀变化",
  model_changed: "切换模型",
  idle: "空闲超时",
  subtask: "子任务",
  evicted: "服务端淘汰",
};

/** 未命中原因的短语（提示行括号里那段）。 */
export function missReasonText(miss: Pick<CacheMiss, "reason" | "detail" | "idleMs">): string {
  const minutes = Math.max(1, Math.round(miss.idleMs / 60_000));
  switch (miss.reason) {
    case "idle":
      return `空闲 ${minutes} 分钟后`;
    case "subtask":
      return `子任务运行 ${minutes} 分钟后`;
    case "model_changed":
      return "切换模型后";
    case "prefix_changed":
      return miss.detail === "tools"
        ? "工具表变化"
        : miss.detail === "system"
          ? "系统提示变化"
          : "前缀变化";
    case "evicted":
      return "服务端已淘汰";
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
  const cost = miss.missedCost === undefined ? "" : `（约 ${formatUsd(miss.missedCost)}）`;
  return `缓存未命中（${missReasonText(miss)}）：重计费 ${formatTokenCount(miss.missedTokens)} token${cost}`;
}

/** `上下文已用 72%，约剩 9 回合（按最近 5 回合均值）`；估不出回合时给余量 token。 */
export function contextPressureNotice(
  event: Extract<SessionEvent, { type: "context_pressure" }>,
): string {
  const head = `上下文已用 ${Math.round(event.percent)}%`;
  if (event.estimatedTurnsLeft !== undefined)
    return `${head}，约剩 ${event.estimatedTurnsLeft} 回合（按最近 5 回合均值）`;
  if (event.remainingTokens !== undefined)
    return `${head}，余量 ${formatTokenCount(event.remainingTokens)} token`;
  return head;
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
  const read =
    event.usage === undefined ? "" : `读 ${formatTokenCount(event.usage.cacheRead)} token`;
  const cost = event.cost === undefined ? "" : `${read !== "" ? "，" : ""}${formatUsd(event.cost)}`;
  return `缓存保温已刷新${read + cost !== "" ? `（${read}${cost}）` : ""}`;
}

/** 消息区 / stderr 是否提示未命中与上下文余量（`cache.missNotices`，缺省 true）。 */
export function cacheNoticesEnabled(session: AgentSession): boolean {
  return session instanceof AgentSessionImpl ? session.cache.cacheSettings.missNotices : true;
}

const STOP_REASONS: Readonly<Record<string, string>> = {
  retention_none: "缓存保留为 none",
  payload_replaced: "请求体被 onPayload 替换",
  thinking_budget: "思考预算随 max_tokens，不可重放",
  reporting_unknown: "端点还没报过缓存",
  reporting_silent: "端点不报缓存",
  no_ttl: "模型目录没有缓存 TTL",
  ttl_too_short: "缓存 TTL 太短",
  max_duration: "已达保温时长上限",
  late: "计时器迟到",
  off: "已关闭",
  stale: "上下文已变",
  declined: "宿主否决",
  error: "保温请求失败",
  no_cache_hits: "连续保温零命中",
  no_price: "缺价格，经济性不可算",
  below_min_savings: "期望节省低于门槛",
};

export function warmStopText(reason: string | undefined): string {
  if (reason === undefined) return "已停止";
  return `已停止：${STOP_REASONS[reason] ?? reason}`;
}

/** `streaming · 下次 2m 10s · 期望节省 $0.18 ≥ $0.05 · 已发 2 次 $0.01`。 */
export function warmingText(
  status: WarmerStatus,
  now: number,
  minSavingsUsd: number | undefined,
): string {
  if (status.mode === "off") return "off";
  const parts: string[] = [status.mode];
  if (status.state === "scheduled") {
    if (status.nextWarmAt !== undefined)
      parts.push(`下次 ${formatDuration(status.nextWarmAt - now)}`);
    if (status.expectedSavingsUsd !== undefined) {
      const floor = minSavingsUsd === undefined ? "" : ` ≥ ${formatUsd(minSavingsUsd)}`;
      parts.push(`期望节省 ${formatUsd(status.expectedSavingsUsd)}${floor}`);
    }
  } else if (status.state === "stopped") parts.push(warmStopText(status.reason));
  else parts.push("待下一次请求");
  if (status.sent !== undefined && status.sent > 0)
    parts.push(`已发 ${status.sent} 次 ${formatUsd(status.costUsd)}`);
  return parts.join(" · ");
}

function missesText(cache: SessionCacheStats): string {
  if (cache.misses.count === 0) return "0 次";
  const by = Object.entries(cache.misses.byReason)
    .filter(([, n]) => n !== undefined && n > 0)
    .map(([reason, n]) => `${REASON_LABELS[reason as CacheMissReason] ?? reason} ${n}`)
    .join(" · ");
  const cost = cache.reBilledUsd === undefined ? "$?" : formatUsd(cache.reBilledUsd);
  return `${cache.misses.count} 次，重计费 ${formatTokenCount(cache.reBilledTokens)} token ≈ ${cost}${by !== "" ? `（${by}）` : ""}`;
}

/** 缓存段的键值行（`/session` 与 `/cache` 共用）。 */
export function cacheRows(session: AgentSession, now: number = Date.now()): KeyValueRow[] {
  const stats = session.getStats();
  const t = stats.tokens;
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  const uncached = t.input + t.cacheWrite;
  const readShare = prompt > 0 ? `（${formatPercent(t.cacheRead / prompt)}）` : " ";
  const write = t.cacheWrite > 0 ? `（其中写入 ${formatTokenCount(t.cacheWrite)}）` : "";
  const rows: KeyValueRow[] = [
    {
      key: "输入",
      value: `${formatTokenCount(prompt)} = 缓存读 ${formatTokenCount(t.cacheRead)}${readShare}+ 未缓存 ${formatTokenCount(uncached)}${write}`,
    },
  ];
  const cache = stats.cache;
  if (cache === undefined) {
    rows.push({ key: "命中率", value: `会话 ${formatPercent(stats.cacheHitRate)}` });
    return rows;
  }
  rows.push({ key: "报告状态", value: reportingLabel(cache.reporting) });
  if (cache.reporting === "reported") {
    rows.push({
      key: "命中率",
      value: `最近 ${formatPercent(cache.lastHitRate)} · 会话 ${formatPercent(cache.hitRate)}`,
    });
  }
  rows.push({ key: "未命中", value: missesText(cache) });
  const minSavings =
    session instanceof AgentSessionImpl ? session.cache.cacheSettings.minSavingsUsd : undefined;
  rows.push({ key: "保温", value: warmingText(cache.warming, now, minSavings) });
  if (stats.contextPercent !== undefined) {
    const remaining =
      cache.contextRemainingTokens === undefined
        ? ""
        : `，余量 ≈ ${formatTokenCount(cache.contextRemainingTokens)} token`;
    const turns =
      cache.estimatedTurnsLeft === undefined ? "" : ` ≈ ${cache.estimatedTurnsLeft} 回合`;
    rows.push({ key: "上下文", value: `${Math.round(stats.contextPercent)}%${remaining}${turns}` });
  }
  if (cache.subagents !== undefined) {
    const sub = cache.subagents;
    const rebill =
      sub.reBilledTokens > 0 ? `，重计费 ${formatTokenCount(sub.reBilledTokens)} token` : "";
    rows.push({
      key: "子任务",
      value: `${sub.count} 个会话，命中率 ${formatPercent(sub.hitRate)}${rebill}`,
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
  const amount =
    usage.unit === "usd"
      ? formatUsd(usage.amount)
      : usage.unit === "tokens"
        ? `${formatTokenCount(usage.amount)} token`
        : `${usage.amount} 次请求`;
  const tokens =
    usage.unit !== "tokens" && usage.tokens !== undefined && usage.tokens > 0
      ? ` · ${formatTokenCount(usage.tokens)} token`
      : "";
  return `${usage.runs} 次运行 · ${amount}${tokens}`;
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
  const parts = [`${tasks.total} 个任务`];
  if (tasks.running > 0) parts.push(`运行中 ${tasks.running}`);
  const labels: Record<string, string> = {
    completed: "完成",
    failed: "失败",
    aborted: "已停止",
    max_turns: "轮数耗尽",
    interrupted: "已中断",
  };
  for (const [status, count] of Object.entries(tasks.byStatus))
    if (count !== undefined && count > 0) parts.push(`${labels[status] ?? status} ${count}`);
  return `${parts.join(" · ")}（/tasks）`;
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
  return ["缓存", ...renderRows(cacheRows(session, now), "  ")].join("\n");
}

export function describeSession(session: AgentSession, now: number = Date.now()): string {
  const state = session.state;
  const stats = session.getStats();
  const model = state.model === undefined ? "?" : `${state.model.provider}/${state.model.id}`;
  const t = stats.tokens;
  const percent = stats.contextPercent === undefined ? "?" : `${Math.round(stats.contextPercent)}`;
  const rows: KeyValueRow[] = [
    {
      key: "会话",
      value: `${state.sessionId}${state.sessionFile !== undefined ? `（${state.sessionFile}）` : "（未落盘）"}`,
    },
    {
      key: "模型",
      value: `${model} · 思考 ${state.thinkingLevel} · 权限 ${state.permissionMode}`,
    },
    {
      key: "消息",
      value: `用户 ${stats.userMessages} · 助手 ${stats.assistantMessages} · 工具调用 ${stats.toolCalls}`,
    },
    {
      key: "用量",
      value:
        `输入 ${t.input} · 输出 ${t.output} · 缓存读 ${t.cacheRead} · 缓存写 ${t.cacheWrite}` +
        (stats.cost !== undefined ? ` · $${stats.cost.toFixed(4)}` : " · $?"),
    },
    {
      key: "上下文",
      value: `${stats.contextTokens ?? "?"} / ${stats.contextWindow ?? "?"}（${percent}%）`,
    },
  ];
  const tasks = taskStatsText(session);
  if (tasks !== undefined) rows.push({ key: "子 Agent", value: tasks });
  const external = externalRows(session);
  const subscription = subscriptionRows(session, now);
  return [
    ...renderRows(rows),
    describeCache(session, now),
    ...(subscription.length > 0
      ? [msg().auth.report.section, ...renderRows(subscription, "  ")]
      : []),
    ...(external.length > 0 ? ["外部 Agent", ...renderRows(external, "  ")] : []),
  ].join("\n");
}

/** `/cache fingerprint`：最近一次真实请求的前缀指纹（system / tools 哈希与模型）。 */
export function describeFingerprint(session: AgentSession): string {
  if (!(session instanceof AgentSessionImpl)) return "当前会话不提供前缀指纹";
  const record = session.cache.lastTurn;
  if (record === undefined) return "还没有真实请求（指纹在第一次请求后记录）";
  const f = record.fingerprint;
  return [
    "前缀指纹（最近一次请求）",
    ...renderRows(
      [
        { key: "system", value: f.system },
        { key: "tools", value: f.tools },
        { key: "model", value: f.model },
      ],
      "  ",
    ),
  ].join("\n");
}
