/**
 * 与语言无关的格式化小工具（docs/wave6-plan.md §5.1；R8 §2.4）。[W6-C0]
 *
 * - `plural`：只有英文需要复数；中文文案直接写「N 个文件」，不调它。
 * - `formatDuration`：紧凑时长，两种语言共用（`45s`、`2m 10s`、`1h24m`）；长句里的「7 分钟」走消息目录。
 *   现有 4 处各自实现（`status-bar.ts`、`session-report.ts`、`tool-summary.ts`、`print-mode.ts`）由各迁移批次
 *   改用这里的变体，前提是 zh 黄金字节不变（`short` / `precise` 两个变体就是为此保留的）。
 * - 数字（`formatTokens` / `formatUsd` / `formatPercent`）与日期（ISO）保持原样，不本地化。
 */

let enRules: Intl.PluralRules | undefined;

function isOne(n: number): boolean {
  try {
    enRules ??= new Intl.PluralRules("en");
    return enRules.select(n) === "one";
  } catch {
    // small-icu / 无 Intl 的环境保底
    return n === 1;
  }
}

/**
 * 英文复数：`plural(1, "file")` → `1 file`，`plural(3, "file")` → `3 files`；
 * 不规则词给第三参数：`plural(2, "entry", "entries")`。
 */
export function plural(n: number, word: string, pluralForm?: string): string {
  return `${n} ${isOne(n) ? word : (pluralForm ?? `${word}s`)}`;
}

/**
 * 时长的紧凑写法。
 * - `compact`（缺省）：`45s`、`2m 10s`、`2m`、`1h24m`、`3h`；
 * - `short`：状态行用（与 `status-bar.ts` 逐字节相同），`45s`、`2m`、`1h0m`、`1h24m`；
 * - `precise`：工具耗时用，`2.1s`（< 10 s 一位小数）、`45s`、`1m05s`。
 */
export function formatDuration(
  ms: number,
  style: "compact" | "short" | "precise" = "compact",
): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (style === "precise") {
    const s = safe / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.floor(s)}s`;
    const total = Math.floor(s);
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
  }
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return style === "short" || rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (style === "short") return `${hours}h${restMinutes}m`;
  return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
}
