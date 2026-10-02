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

export const STATS_USAGE = `用法：ama stats [--since 7d|30d|today|YYYY-MM-DD] [--until …]
                 [--by day|week|month|provider|channel|model|project]
                 [--project <目录> | --all] [--top N] [--json] [--no-cache] [--session-dir <目录>]
`;

/** `7d` / `today` / `YYYY-MM-DD` → 本地日期。 */
export function parseDaySpec(option: string, raw: string, now = new Date()): string {
  if (raw === "today") return localDay(now.toISOString()) ?? "";
  const rel = /^(\d+)d$/.exec(raw);
  if (rel !== null) {
    const days = Number(rel[1]);
    if (days < 1) throw new UsageError(`--${option} 的天数至少为 1（收到 ${raw}）`);
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1));
    return localDay(d.toISOString()) ?? "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00`))) return raw;
  throw new UsageError(`--${option} 应为 7d、today 或 YYYY-MM-DD（收到 ${raw}）`);
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
  return t.cost >= 0.01 || t.cost === 0 ? `$${t.cost.toFixed(2)}` : `$${t.cost.toFixed(4)}`;
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
  const range =
    report.since === undefined && report.until === undefined
      ? "全部时间"
      : `${report.since ?? "最早"} – ${report.until ?? "今天"}`;
  const lines: string[] = [`${range} · ${scope} · ${report.sessions} 个会话`];
  if (t.requests === 0) {
    lines.push("没有模型请求");
    return lines.join("\n") + "\n";
  }
  const kinds = Object.entries(report.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind === "turn" ? "对话" : kind} ${n}`)
    .join(" · ");
  const costLine =
    t.cost === undefined
      ? "— （所有请求的模型都无价格，见 token）"
      : t.unpriced > 0
        ? `${usd(t)}（另有 ${t.unpriced} 次请求无价，未计入）`
        : usd(t);
  const rows: string[][] = [
    ["请求", `${t.requests}（${kinds}）`],
    ["回合", `${t.turns} · 平均耗时 ${seconds(t.avgTurnMs)}`],
    [
      "Token",
      `输入 ${formatTokens(t.input)} · 输出 ${formatTokens(t.output)} · 缓存读 ${formatTokens(t.cacheRead)} · 缓存写 ${formatTokens(t.cacheWrite)}`,
    ],
    [
      "缓存命中率",
      `${percent(t.hitRate)}（报告缓存的端点 ${report.endpoints.reported}/${report.endpoints.total}，其余不进分母）`,
    ],
    ["费用", costLine],
    ["错误 / 重试", `${t.errors} / ${t.retries}`],
  ];
  lines.push(table(rows, () => false));
  if (report.groups !== undefined && report.groups.length > 0) {
    const head = ["", "会话", "请求", "回合", "输入", "输出", "缓存读", "缓存写", "命中率", "费用"];
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
    lines.push("", `工具调用 Top ${report.tools.length}`);
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
    io.stdout(STATS_USAGE);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) throw new UsageError(`ama stats 不接受位置参数：${positionals[0]}`);
  const now = new Date();
  const since = values.has("since") ? parseDaySpec("since", values.get("since")!, now) : undefined;
  const until = values.has("until") ? parseDaySpec("until", values.get("until")!, now) : undefined;
  const byRaw = values.get("by");
  if (byRaw !== undefined && !(STATS_GROUPS as readonly string[]).includes(byRaw)) {
    throw new UsageError(`--by 的取值应为 ${STATS_GROUPS.join(" | ")}（收到 ${byRaw}）`);
  }
  const by = byRaw as StatsGroupBy | undefined;
  const top = Number(values.get("top") ?? "10");
  if (!Number.isInteger(top) || top < 0) throw new UsageError("--top 应为非负整数");
  if (flags.has("all") && values.has("project")) {
    throw new UsageError("--project 与 --all 不能同时使用");
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
  io.stdout(renderStats(report, project === undefined ? "全部项目" : `项目 ${project}`));
  if (collected.invalid > 0) io.stderr(`ama: 跳过 ${collected.invalid} 个无法读取的会话文件\n`);
  return ExitCode.Ok;
}
