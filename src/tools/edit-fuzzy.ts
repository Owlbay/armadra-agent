/**
 * 文本归一与模糊匹配（设计 §5.2 edit：先精确再模糊）。[B3]
 *
 * - BOM / 换行：`splitBom`、`detectLineEnding`、`normalizeToLF`、`restoreLineEndings`，write 与
 *   edit 共用，保证写回时保留原文件的 BOM 与 CRLF。
 * - 模糊归一 `normalizeForFuzzy`：NFKC、去行尾空白、弯引号 / 各种破折号 / 特殊空格归 ASCII。
 *   归一**不改变行数**，所以模糊匹配在归一空间算出的替换可以按行映射回原文：
 *   `applyPreservingLines()` 只重写被替换触及的行，其余行逐字节保留原文。
 */

export const BOM = "\uFEFF";

export function splitBom(text: string): { bom: string; text: string } {
  return text.startsWith(BOM) ? { bom: BOM, text: text.slice(1) } : { bom: "", text };
}

/** 以第一处换行为准；无换行视为 LF。 */
export function detectLineEnding(text: string): "\r\n" | "\n" {
  const lf = text.indexOf("\n");
  if (lf === -1) return "\n";
  return lf > 0 && text[lf - 1] === "\r" ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function normalizeForFuzzy(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** 不重叠的全部出现位置。 */
export function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === "") return out;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return out;
    out.push(idx);
    from = idx + needle.length;
  }
}

/** 偏移量所在行（1 起）。 */
export function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export interface Replacement {
  /** 在基准文本中的起点与长度。 */
  index: number;
  length: number;
  newText: string;
}

/** 按起点倒序应用（调用方保证不重叠）。 */
export function applyReplacements(base: string, replacements: readonly Replacement[]): string {
  const sorted = [...replacements].sort((a, b) => b.index - a.index);
  let out = base;
  for (const r of sorted) out = out.slice(0, r.index) + r.newText + out.slice(r.index + r.length);
  return out;
}

interface Span {
  start: number;
  end: number;
}

function lineSpans(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      spans.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length || text.length === 0) spans.push({ start, end: text.length });
  return spans;
}

function lineIndexOf(spans: readonly Span[], offset: number): number {
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i] as Span;
    if (offset >= s.start && offset < s.end) return i;
  }
  return spans.length - 1;
}

/**
 * `base` 是 `original` 的模糊归一视图（同行数）。替换在 base 上算出；被触及的行组从 base 改写，
 * 其余行原样拷回 original，避免把整份文件的行尾空白、弯引号一并改掉。
 */
export function applyPreservingLines(
  original: string,
  base: string,
  replacements: readonly Replacement[],
): string {
  const origSpans = lineSpans(original);
  const baseSpans = lineSpans(base);
  if (origSpans.length !== baseSpans.length) return applyReplacements(base, replacements);

  const groups: { first: number; last: number; items: Replacement[] }[] = [];
  for (const r of [...replacements].sort((a, b) => a.index - b.index)) {
    const first = lineIndexOf(baseSpans, r.index);
    const last = lineIndexOf(baseSpans, Math.max(r.index, r.index + r.length - 1));
    const current = groups[groups.length - 1];
    if (current && first <= current.last) {
      current.last = Math.max(current.last, last);
      current.items.push(r);
    } else {
      groups.push({ first, last, items: [r] });
    }
  }

  let out = "";
  let nextLine = 0;
  for (const g of groups) {
    for (let i = nextLine; i < g.first; i++) {
      const s = origSpans[i] as Span;
      out += original.slice(s.start, s.end);
    }
    const gStart = (baseSpans[g.first] as Span).start;
    const gEnd = (baseSpans[g.last] as Span).end;
    const local = g.items.map((r) => ({ ...r, index: r.index - gStart }));
    out += applyReplacements(base.slice(gStart, gEnd), local);
    nextLine = g.last + 1;
  }
  for (let i = nextLine; i < origSpans.length; i++) {
    const s = origSpans[i] as Span;
    out += original.slice(s.start, s.end);
  }
  return out;
}
