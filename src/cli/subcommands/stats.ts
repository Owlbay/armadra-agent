/**
 * `ama stats`：跨会话的用量统计（只读扫描会话 JSONL）。[W4-D]
 *
 * - 范围：缺省当前目录的会话；`--project <目录>` 指定项目；`--all` 全部（`--by project` 未指定范围时也看全部）。
 * - 时间：`--since` / `--until` 接受 `7d`（含今天的最近 7 天）、`today`、`YYYY-MM-DD`（本地日期，含当天）。
 * - 分组：`--by day|week|month|provider|channel|model|project`。
 * - 缓存：`<数据目录>/stats-index.json`，按文件 mtime / size 失效；`--no-cache` 不读也不写。
 * - 口径见 session/stats-aggregate.ts 与 docs/sessions.md「统计」。
 */

import { join, resolve } from "node:path";
import { expandHome, resolveDataDir } from "../../config/paths.js";
import { sessionFilesInScope } from "../../session/scan.js";
import {
  STATS_GROUPS,
  aggregateStats,
  type StatsGroupBy,
  type StatsReport,
  type StatsTotals,
} from "../../session/stats-aggregate.js";
import { STATS_INDEX_FILE, collectSummaries } from "../../session/stats-index.js";
import { localDay } from "../../session/stats-scan.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { msg } from "../../i18n/index.js";

export function statsUsage(): string {
  return msg().subcommands.stats.usage;
}

/** `7d` / `today` / `YYYY-MM-DD` → 本地日期。 */
export function parseDaySpec(option: string, raw: string, now = new Date()): string {
  if (raw === "today") return localDay(now.toISOString()) ?? "";
  const rel = /^(\d+)d$/.exec(raw);
  if (rel !== null) {
    const days = Number(rel[1]);
    if (days < 1) throw new UsageError(msg().subcommands.stats.daysAtLeastOne(option, raw));
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1));
    return localDay(d.toISOString()) ?? "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00`))) return raw;
  throw new UsageError(msg().subcommands.stats.daySpec(option, raw));
}

export function formatTokens(count: number): string {
  const trim = (text: string): string => text.replace(/\.?0+$/, "");
  if (count < 1000) return String(Math.round(count));
  if (count < 100_000) return `${trim((count / 1000).toFixed(1))}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${trim((count / 1_000_000).toFixed(2))}M`;
}

const percent = (rate: number | undefined): string =>
  rate === undefined ? "—" : `${(rate * 100).toFixed(1)}%`;

const usd = (t: StatsTotals): string => {
  if (t.cost === undefined) return "—";
  return t.cost >= 1 || t.cost === 0 ? `$${t.cost.toFixed(2)}` : `$${t.cost.toFixed(4)}`;
};

function seconds(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`;
}

function width(text: string): number {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return w;
}

function table(rows: readonly string[][], rightAlign: (col: number) => boolean): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, width(cell))));
  return rows
    .map((row) =>
      row
        .map((cell, i) => {
          const padding = " ".repeat((widths[i] ?? 0) - width(cell));
          return rightAlign(i) ? padding + cell : cell + padding;
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function renderStats(report: StatsReport, scope: string): string {
  const t = report.totals;
  const m = msg().subcommands.stats;
  const range =
    report.since === undefined && report.until === undefined
      ? m.allTime
      : m.range(report.since, report.until);
  const lines: string[] = [m.header(range, scope, report.sessions)];
  if (t.requests === 0) {
    lines.push(m.noRequests);
    return lines.join("\n") + "\n";
  }
  const kinds = Object.entries(report.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind === "turn" ? m.kindTurn : kind} ${n}`)
    .join(" · ");
  const costLine =
    t.cost === undefined
      ? t.unpriced > 0
        ? m.costUnpriced
        : "—"
      : t.unpriced > 0
        ? m.costPartial(usd(t), t.unpriced)
        : usd(t);
  const rows: string[][] = [
    [m.rows.requests, m.requestsValue(t.requests, kinds)],
    [m.rows.turns, m.turnsValue(t.turns, seconds(t.avgTurnMs))],
    [
      m.rows.tokens,
      m.tokensValue(
        formatTokens(t.input),
        formatTokens(t.output),
        formatTokens(t.cacheRead),
        formatTokens(t.cacheWrite),
      ),
    ],
    [
      m.rows.hitRate,
      m.hitRateValue(percent(t.hitRate), report.endpoints.reported, report.endpoints.total),
    ],
    [m.rows.cost, costLine],
    ...(t.subscription !== undefined
      ? [[m.rows.subscription, m.subscriptionValue(t.subscription)]]
      : []),
    [m.rows.errors, `${t.errors} / ${t.retries}`],
  ];
  lines.push(table(rows, () => false));
  if (report.groups !== undefined && report.groups.length > 0) {
    const gh = m.groupHead;
    const head = [
      "",
      gh.sessions,
      gh.requests,
      gh.turns,
      gh.input,
      gh.output,
      gh.cacheRead,
      gh.cacheWrite,
      gh.hitRate,
      gh.cost,
    ];
    const body = report.groups.map((g) => [
      g.key,
      String(g.sessions),
      String(g.requests),
      String(g.turns),
      formatTokens(g.input),
      formatTokens(g.output),
      formatTokens(g.cacheRead),
      formatTokens(g.cacheWrite),
      percent(g.hitRate),
      usd(g) + (g.cost !== undefined && g.unpriced > 0 ? "+" : ""),
    ]);
    lines.push(
      "",
      table([head, ...body], (i) => i > 0),
    );
  }
  if (report.tools.length > 0) {
    lines.push("", m.topTools(report.tools.length));
    lines.push(
      table(
        report.tools.map((tool) => [`  ${tool.name}`, String(tool.count)]),
        (i) => i > 0,
      ),
    );
  }
  return lines.join("\n") + "\n";
}

export async function runStats(argv: readonly string[], io: CliIo): Promise<number> {
  const { positionals, values, flags } = parseSubArgs(
    argv,
    ["since", "until", "by", "project", "session-dir", "top"],
    ["all", "json", "no-cache"],
  );
  if (flags.has("help")) {
    io.stdout(statsUsage());
    return ExitCode.Ok;
  }
  if (positionals.length > 0)
    throw new UsageError(msg().subcommands.stats.noPositionals(positionals[0] ?? ""));
  const now = new Date();
  const since = values.has("since") ? parseDaySpec("since", values.get("since")!, now) : undefined;
  const until = values.has("until") ? parseDaySpec("until", values.get("until")!, now) : undefined;
  const byRaw = values.get("by");
  if (byRaw !== undefined && !(STATS_GROUPS as readonly string[]).includes(byRaw)) {
    throw new UsageError(msg().subcommands.common.invalidChoice("--by", STATS_GROUPS, byRaw));
  }
  const by = byRaw as StatsGroupBy | undefined;
  const top = Number(values.get("top") ?? "10");
  if (!Number.isInteger(top) || top < 0)
    throw new UsageError(msg().subcommands.stats.topNonNegative);
  if (flags.has("all") && values.has("project")) {
    throw new UsageError(msg().cli.args.flagConflict("--project", "--all"));
  }
  const dataDir = resolveDataDir({ env: io.env });
  const dirFlag = values.get("session-dir");
  const root =
    dirFlag !== undefined
      ? resolve(io.cwd, expandHome(dirFlag, { env: io.env }))
      : join(dataDir, "sessions");
  const projectFlag = values.get("project");
  const project =
    projectFlag !== undefined
      ? resolve(io.cwd, expandHome(projectFlag, { env: io.env }))
      : flags.has("all") || by === "project"
        ? undefined
        : io.cwd;
  const files = sessionFilesInScope(root, project);
  const useCache = !flags.has("no-cache");
  const collected = collectSummaries(files, {
    ...(useCache ? { indexFile: join(dataDir, STATS_INDEX_FILE) } : {}),
    prune: project === undefined,
  });
  const report = aggregateStats(collected.summaries, {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(by !== undefined ? { by } : {}),
    topTools: top,
  });
  if (flags.has("json")) {
    io.stdout(
      JSON.stringify(
        {
          scope: project === undefined ? { all: true } : { project },
          ...report,
          files: {
            total: files.length,
            scanned: collected.scanned,
            cached: collected.cached,
            invalid: collected.invalid,
          },
        },
        null,
        2,
      ) + "\n",
    );
    return ExitCode.Ok;
  }
  const m = msg().subcommands.stats;
  io.stdout(renderStats(report, project === undefined ? m.allProjects : m.project(project)));
  if (collected.invalid > 0) io.stderr(m.skippedInvalid(collected.invalid));
  return ExitCode.Ok;
}
