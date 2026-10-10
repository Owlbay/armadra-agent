/**
 * 轨迹 HTML 导出：`ama sessions trace --html`（docs/history/wave6-plan.md §2.5、D7）。[W6-T2]
 *
 * 产物是**单文件、零依赖**的页面：样式与脚本内联（`html-template.ts`），数据放
 * `<script type="application/json">`，`<meta>` CSP 禁止一切外联。页面在浏览器里只用 `textContent` 写字，
 * 不拼 HTML。
 *
 * 这里把 `Trace` 摊成「行」（全部展开的扁平树：深度、父行、标签、耗时 / token / 缓存列、瀑布分段、详情键值、
 * 预览），页面只做折叠、虚拟滚动、搜索、缩放与详情。
 *
 * - **双重脱敏**：整棵轨迹先 `redactValue`；正文经「先 redactValue 再读」的条目查找表取（标签里的提示预览、
 *   工具参数摘要、详情预览都来自脱敏后的条目），预览自身再 `redactSecrets`（`preview.ts`）；序列化时
 *   `<`、`>`、`&`、U+2028 / U+2029 全部转成 `\uXXXX`，数据里不可能出现 `</script>` 或 `<!--`。
 * - `content: false`（`--no-content`）：不读条目，标签只剩结构，详情去掉错误 / 原因两行，没有预览。
 * - `children: false`：子会话的结构照样嵌（行与数字），预览只给本会话的节点。
 * - 预览总预算（缺省 4 MB 字符）：从最后一行往前计，超出后更早的预览置空并标注。
 * - 横轴：会话时间，回合之间超过 2 秒的空闲压缩成 2 秒（页面标注）；`axis` 给出原始 → 轴上的折点，
 *   刻度按原始时间标注。
 * - 确定性：不读时钟；生成时间与版本由调用方传入，写进页脚。
 */

import { getLocale, msg } from "../i18n/index.js";
import { formatUsd } from "../modes/session-report.js";
import { redactSecrets, redactValue } from "../session/redact.js";
import type { SessionEntry } from "../session/types.js";
import { plainTheme } from "../tui/theme.js";
import { describeNode, summaryRows, type TraceEntryLookup } from "./detail.js";
import { defaultExpanded, flattenTrace, turnSpan, type TraceRow } from "./flatten.js";
import { cacheText, durationText, rowLabel, summaryText, tokensText } from "./format.js";
import { renderPage } from "./html-template.js";
import { previewOf, previewSize, type TracePreview } from "./preview.js";
import type { Trace } from "./types.js";

/** 预览总预算（字符）。 */
export const PREVIEW_BUDGET = 4 * 1024 * 1024;
/** 回合之间的空闲在轴上最多占这么长（ms）。 */
export const IDLE_CAP_MS = 2000;

export interface TraceHtmlOptions {
  /** 是否带正文（标签里的提示 / 参数摘要、详情预览）。 */
  content: boolean;
  /** 是否内嵌子会话节点的预览。 */
  children: boolean;
  /** 生成时间（epoch ms），写页脚。 */
  generatedAt: number;
  /** 正文来源（含已加载子会话的条目）；`content` 为 false 时不用。 */
  lookup?: TraceEntryLookup;
  /** 写页脚的 ama 版本。 */
  version: string;
  /** 测试用：覆盖预览总预算。 */
  previewBudget?: number;
}

/** 瀑布分段：`[轴上起点, 轴上终点, 类别]`；起点 = 终点表示进行中的起点标记。 */
type Seg = [number, number, SegClass];
type SegClass = "turn" | "ttft" | "dec" | "tool" | "agent" | "wait" | "oth" | "run";

/** 页面里的一行。键名短，数据量大时省体积。 */
export interface HtmlRow {
  /** 深度。 */
  d: number;
  /** 父行下标（-1 = 顶层）。 */
  p: number;
  /** 节点种类。 */
  k: string;
  /** 状态（i18n 后）；完成时省略。 */
  s?: string;
  /** 状态码（样式用）。 */
  sc?: string;
  l: string;
  /** 耗时 / token / 缓存列。 */
  du?: string;
  tk?: string;
  ca?: string;
  /** 缺省展开。 */
  e?: 1;
  /** 回合序号（顶层回合行，跳转用）。 */
  t?: number;
  g?: Seg[];
  /** 详情键值。 */
  kv: [string, string][];
  /** 预览（标题 → 正文）。 */
  pv?: [string, string][];
  /** 预览因预算被省略。 */
  pd?: 1;
  /** 在子会话里且没有 `--children`（预览未内嵌）。 */
  pc?: 1;
}

export interface HtmlData {
  lang: string;
  title: string;
  summary: string;
  meta: string;
  footer: string;
  /** 原始时间 → 轴上时间的折点（相对会话开始，ms）。 */
  axis: [number, number][];
  /** 轴总长（ms）。 */
  span: number;
  content: boolean;
  rows: HtmlRow[];
  i18n: Record<string, string>;
}

/** 全部展开（任何 key 都展开）。 */
const EXPAND_ALL: ReadonlyMap<string, boolean> = {
  get: () => true,
} as unknown as ReadonlyMap<string, boolean>;

/** 正文查找表：条目先整条 `redactValue` 再给 describe / preview 用。 */
export function redactedLookup(lookup: TraceEntryLookup): TraceEntryLookup {
  const cache = new Map<string, SessionEntry | undefined>();
  return {
    ...(lookup.cwd !== undefined ? { cwd: lookup.cwd } : {}),
    entry(id) {
      if (!cache.has(id)) {
        const raw = lookup.entry(id);
        cache.set(id, raw === undefined ? undefined : redactValue(raw));
      }
      return cache.get(id);
    },
  };
}

/** 原始时间 → 轴：合并回合时间窗，窗口之间的空闲压到 `IDLE_CAP_MS`。 */
export function axisPoints(trace: Trace): [number, number][] {
  const t0 = trace.startedAt;
  const windows: [number, number][] = [];
  for (const turn of trace.turns) {
    const span = turnSpan(turn);
    if (span !== undefined) windows.push([span.start - t0, span.end - t0]);
  }
  for (const aux of trace.aux)
    if (aux.startedAt !== undefined)
      windows.push([aux.startedAt - t0, (aux.endedAt ?? aux.startedAt) - t0]);
  windows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const points: [number, number][] = [[0, 0]];
  let raw = 0;
  let mapped = 0;
  for (const [start, end] of windows) {
    if (end <= raw) continue;
    const from = Math.max(start, raw);
    if (from > raw) {
      mapped += Math.min(from - raw, IDLE_CAP_MS);
      raw = from;
      points.push([raw, mapped]);
    }
    mapped += end - raw;
    raw = end;
    points.push([raw, mapped]);
  }
  return points;
}

/** 按折点映射（折点之外按 1:1 外推）。 */
export function mapTime(points: readonly [number, number][], raw: number): number {
  let prev = points[0] ?? [0, 0];
  for (const point of points) {
    if (raw <= point[0]) {
      const [r0, m0] = prev;
      const [r1, m1] = point;
      return r1 === r0 ? m1 : m0 + ((raw - r0) * (m1 - m0)) / (r1 - r0);
    }
    prev = point;
  }
  return prev[1] + (raw - prev[0]);
}

function segments(row: TraceRow, at: (t: number) => number): Seg[] {
  const node = row.node;
  if (node.kind === "more" || node.kind === "aux_group") return [];
  const out: Seg[] = [];
  const running = node.status === "running" && node.endedAt === undefined;
  const bar = (from: number | undefined, to: number | undefined, cls: SegClass): void => {
    if (from === undefined) return;
    if (to === undefined) {
      if (running) out.push([at(from), at(from), "run"]);
      return;
    }
    out.push([at(from), at(Math.max(from, to)), cls]);
  };
  switch (node.kind) {
    case "turn":
      if (node.startedAt !== undefined) {
        const span = turnSpan(node);
        bar(node.startedAt, running ? undefined : span?.end, "turn");
      }
      break;
    case "step": {
      const start = node.requestAt ?? node.startedAt;
      if (node.firstTokenAt !== undefined) {
        bar(start, node.firstTokenAt, "ttft");
        bar(node.firstTokenAt, node.doneAt, "dec");
      } else bar(start, node.doneAt ?? node.endedAt, "dec");
      break;
    }
    case "retry_wait":
      bar(
        node.startedAt,
        node.startedAt === undefined ? undefined : node.startedAt + node.delayMs,
        "wait",
      );
      break;
    case "compaction":
    case "aux":
      bar(node.startedAt, node.endedAt, "oth");
      break;
    case "subagent":
      bar(node.startedAt, node.endedAt, "agent");
      break;
    default:
      bar(node.startedAt, node.endedAt, "tool");
  }
  return out;
}

const PREVIEW_ORDER = ["input", "output", "args", "result"] as const;

function previewPairs(p: TracePreview): [string, string][] {
  const d = msg().trace.detail;
  return PREVIEW_ORDER.flatMap((key) => {
    const text = p[key];
    return text === undefined ? [] : [[d[key], text] as [string, string]];
  });
}

/** 轨迹 → 页面数据（已脱敏；纯函数）。 */
export function traceHtmlData(source: Trace, opts: TraceHtmlOptions): HtmlData {
  const m = msg().trace;
  const theme = plainTheme();
  const trace = redactValue(source);
  const lookup =
    opts.content && opts.lookup !== undefined ? redactedLookup(opts.lookup) : undefined;
  const describe =
    lookup === undefined
      ? undefined
      : (node: Parameters<typeof describeNode>[0]) => describeNode(node, lookup);
  const t0 = trace.startedAt;
  const axis = axisPoints(trace);
  const at = (t: number): number => Math.round(mapTime(axis, t - t0));
  const dropKeys = new Set([m.detail.error, m.detail.reason]);
  const flat = flattenTrace(trace, { expanded: EXPAND_ALL });
  const rows: HtmlRow[] = [];
  const parents: number[] = [];
  /** 各深度上的行是否在子 Agent 的子树里（不含子 Agent 行本身）。 */
  const under: boolean[] = [];
  let span = axis.at(-1)?.[1] ?? 0;
  flat.forEach((row, i) => {
    parents.length = row.depth;
    const node = row.node;
    const out: HtmlRow = {
      d: row.depth,
      p: row.depth === 0 ? -1 : (parents[row.depth - 1] ?? -1),
      k: node.kind,
      l: redactSecrets(rowLabel(row, describe === undefined ? {} : { describe })),
      kv: [],
    };
    const parent = out.p < 0 ? undefined : rows[out.p];
    const inChild = row.depth > 0 && ((under[row.depth - 1] ?? false) || parent?.k === "subagent");
    under[row.depth] = inChild;
    parents[row.depth] = i;
    if (node.kind !== "more" && node.kind !== "aux_group") {
      if (node.status !== "ok") {
        out.s = m.status[node.status];
        out.sc = node.status;
      }
      const du = durationText(node, theme);
      if (du !== "") out.du = du;
      const tk = tokensText(node, theme);
      if (tk !== "") out.tk = tk;
      const ca = cacheText(node);
      if (ca !== "") out.ca = ca;
      out.kv = summaryRows(node, theme, t0)
        .filter(([label]) => opts.content || !dropKeys.has(label))
        .map(([label, value]) => [label, redactSecrets(value)]);
      const g = segments(row, at);
      if (g.length > 0) {
        out.g = g;
        for (const seg of g) span = Math.max(span, seg[1]);
      }
      if (lookup !== undefined) {
        if (inChild && !opts.children) out.pc = 1;
        else {
          const p = previewOf(node, lookup);
          if (p !== undefined && previewSize(p) > 0) out.pv = previewPairs(p);
        }
      }
    }
    if (row.expandable && defaultExpanded(node)) out.e = 1;
    if (node.kind === "turn" && row.depth === 0) out.t = row.turn;
    rows.push(out);
  });
  // 预览总预算：从后往前
  let budget = opts.previewBudget ?? PREVIEW_BUDGET;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as HtmlRow;
    if (row.pv === undefined) continue;
    const size = row.pv.reduce((n, [, text]) => n + text.length, 0);
    if (size <= budget) budget -= size;
    else {
      budget = 0;
      delete row.pv;
      row.pd = 1;
    }
  }
  const h = m.html;
  const generated = new Date(opts.generatedAt).toISOString();
  const cost = trace.totals.cost !== undefined ? ` · ${formatUsd(trace.totals.cost)}` : "";
  const started = new Date(t0).toISOString();
  return {
    lang: getLocale() === "zh" ? "zh-CN" : "en",
    title: h.docTitle(trace.sessionId),
    summary: `${summaryText(trace, theme)}${cost}`,
    meta: `${trace.cwd} · ${started}${trace.partial ? ` · ${m.status.running}` : ""}`,
    footer: h.footer(opts.version, generated),
    axis,
    span: Math.max(1, span),
    content: opts.content,
    rows,
    i18n: {
      search: h.search,
      noMatch: h.noMatch,
      jump: h.jump,
      zoomIn: h.zoomIn,
      zoomOut: h.zoomOut,
      zoomFit: h.zoomFit,
      expandAll: h.expandAll,
      collapseAll: h.collapseAll,
      ttft: h.legendTtft,
      dec: h.legendDecode,
      tool: h.legendTool,
      agent: h.legendAgent,
      wait: h.legendWait,
      oth: h.legendOther,
      axisNote: h.axisNote,
      detailEmpty: h.detailEmpty,
      noContent: h.noContent,
      previewDropped: h.previewDropped,
      childPreviewOff: h.childPreviewOff,
      keys: h.keys,
      empty: m.empty,
    },
  };
}

/**
 * 嵌进 `<script type="application/json">` 的 JSON：`<`、`>`、`&` 与 U+2028 / U+2029 转成 `\uXXXX`。
 * 结果仍是合法 JSON（`JSON.parse` 还原原值），且不含 `</script>`、`<!--` 等能截断或改变脚本块的序列。
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => {
    const code = c.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

/** 渲染整页 HTML。 */
export function renderTraceHtml(trace: Trace, opts: TraceHtmlOptions): string {
  const data = traceHtmlData(trace, opts);
  return renderPage({ lang: data.lang, title: data.title, json: scriptSafeJson(data) });
}
