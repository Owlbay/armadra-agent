/**
 * ANSI 与列宽工具（设计 §12.1、§12.2）。[B4]
 *
 * - 列宽按字素簇（grapheme）计：东亚宽字符与 emoji 占 2 列，组合字符 / 零宽字符占 0 列，
 *   控制字符占 0 列；CSI / OSC / APC / DCS 等转义序列不占列。
 * - 宽度表自写（零依赖）：东亚宽 / 全角区段 + Unicode 属性转义（`\p{Emoji_Presentation}` 等）。
 * - 所有截断 / 切片在保留 SGR 样式的同时，于末尾补 `\x1b[0m`，保证「每行末尾重置样式」。
 */

export const SGR_RESET = "\x1b[0m";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 东亚宽（W）与全角（F）区段，含常见 emoji 区块；按起点升序，二分查找。 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function inWideTable(cp: number): boolean {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = WIDE_RANGES[mid]!;
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

const ZERO_WIDTH_RE = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u;
const PICTOGRAPHIC_RE = /^\p{Extended_Pictographic}$/u;

/** 单个码点的列宽（0 / 1 / 2）。 */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  const ch = String.fromCodePoint(cp);
  if (ZERO_WIDTH_RE.test(ch)) return 0;
  if (inWideTable(cp) || EMOJI_PRESENTATION_RE.test(ch)) return 2;
  return 1;
}

/** 一个字素簇的列宽：首码点决定基础宽度；VS16（U+FE0F）把文本型 emoji 升为 2 列。 */
export function graphemeWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0);
  if (first === undefined) return 0;
  if (grapheme.length === 1) return codePointWidth(first);
  const base = codePointWidth(first);
  if (base === 0) {
    // 孤立的组合字符：取后续码点中第一个非零宽者
    for (const ch of grapheme) {
      const w = codePointWidth(ch.codePointAt(0)!);
      if (w > 0) return w;
    }
    return 0;
  }
  if (base === 1 && grapheme.includes("\uFE0F")) {
    const firstChar = String.fromCodePoint(first);
    if (PICTOGRAPHIC_RE.test(firstChar)) return 2;
  }
  return base;
}

/** 从 i 起的转义序列长度；不是转义序列返回 0。未终止的序列吃到字符串末尾。 */
export function escapeLengthAt(s: string, i: number): number {
  if (s.charCodeAt(i) !== 0x1b) return 0;
  const next = s[i + 1];
  if (next === undefined) return 1;
  if (next === "[") {
    let j = i + 2;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j - i + 1;
      j++;
    }
    return s.length - i;
  }
  if (next === "]" || next === "_" || next === "P" || next === "^" || next === "X") {
    let j = i + 2;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 0x07) return j - i + 1;
      if (c === 0x1b && s[j + 1] === "\\") return j - i + 2;
      j++;
    }
    return s.length - i;
  }
  return 2;
}

export function stripAnsi(s: string): string {
  if (!s.includes("\x1b")) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const esc = escapeLengthAt(s, i);
    if (esc > 0) {
      i += esc;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

function isPlainAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** 字符串（不含转义序列）的列宽。 */
function textWidth(text: string): number {
  if (isPlainAscii(text)) return text.length;
  let width = 0;
  for (const { segment } of segmenter.segment(text)) width += graphemeWidth(segment);
  return width;
}

/** 可见列宽：跳过 ANSI 转义序列，按字素簇计宽。 */
export function visibleWidth(s: string): number {
  if (isPlainAscii(s)) return s.length;
  return textWidth(stripAnsi(s));
}

/** 文本片段：转义序列或单个字素簇。 */
interface Piece {
  readonly text: string;
  readonly width: number;
  readonly escape: boolean;
}

function* pieces(s: string): Generator<Piece> {
  let i = 0;
  while (i < s.length) {
    const esc = escapeLengthAt(s, i);
    if (esc > 0) {
      yield { text: s.slice(i, i + esc), width: 0, escape: true };
      i += esc;
      continue;
    }
    let j = i;
    while (j < s.length && s.charCodeAt(j) !== 0x1b) j++;
    const run = s.slice(i, j);
    if (isPlainAscii(run)) {
      for (const ch of run) yield { text: ch, width: 1, escape: false };
    } else {
      for (const { segment } of segmenter.segment(run)) {
        yield { text: segment, width: graphemeWidth(segment), escape: false };
      }
    }
    i = j;
  }
}

function isSgr(seq: string): boolean {
  return seq.startsWith("\x1b[") && seq.endsWith("m");
}

function isSgrReset(seq: string): boolean {
  return seq === "\x1b[0m" || seq === "\x1b[m";
}

/** 跟踪当前生效的 SGR 序列（遇到重置清空）。 */
class SgrState {
  private codes: string[] = [];
  apply(seq: string): void {
    if (!isSgr(seq)) return;
    if (isSgrReset(seq)) this.codes = [];
    else this.codes.push(seq);
  }
  get active(): string {
    return this.codes.join("");
  }
  get any(): boolean {
    return this.codes.length > 0;
  }
}

/** 截断到不超过 width 列；超出时以 ellipsis 结尾；含样式时末尾补重置。 */
export function truncateToWidth(s: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(s) <= width) return s;
  const ellWidth = visibleWidth(ellipsis);
  const budget = ellWidth > width ? width : width - ellWidth;
  let out = "";
  let used = 0;
  let styled = false;
  for (const piece of pieces(s)) {
    if (piece.escape) {
      out += piece.text;
      if (isSgr(piece.text)) styled = true;
      continue;
    }
    if (used + piece.width > budget) break;
    out += piece.text;
    used += piece.width;
  }
  if (ellWidth <= width) out += ellipsis;
  return styled ? out + SGR_RESET : out;
}

/**
 * 取 [start, end) 列区间。开头补上 start 处生效的 SGR，末尾补重置；
 * 被边界切开的宽字符用空格代替，保证结果恰好占 end - start 列（不足时按原内容）。
 */
export function sliceByColumn(s: string, start: number, end: number): string {
  if (end <= start) return "";
  const state = new SgrState();
  let out = "";
  let col = 0;
  let started = false;
  let styled = false;
  for (const piece of pieces(s)) {
    if (piece.escape) {
      if (!started && (col < start || isSgr(piece.text))) state.apply(piece.text);
      else if (col < end) {
        out += piece.text;
        if (isSgr(piece.text)) styled = true;
      }
      continue;
    }
    const next = col + piece.width;
    if (next <= start) {
      col = next;
      continue;
    }
    if (col >= end) break;
    if (!started) {
      started = true;
      if (state.any) {
        out = state.active + out;
        styled = true;
      }
    }
    if (col < start || next > end) {
      // 宽字符跨边界：只保留落在区间内的列，用空格填充
      const inside = Math.min(next, end) - Math.max(col, start);
      out += " ".repeat(inside);
    } else {
      out += piece.text;
    }
    col = next;
  }
  return styled ? out + SGR_RESET : out;
}

/** 右侧补空格到 width 列（已超出则原样返回）。 */
export function padToWidth(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** 自动换行：按空白断词，超长词按字素断开；样式跨行延续（行尾重置、下一行开头恢复）。 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const result: string[] = [];
  const state = new SgrState();
  for (const logical of text.split("\n")) {
    wrapLogicalLine(logical, width, state, result);
  }
  return result;
}

function wrapLogicalLine(line: string, width: number, state: SgrState, out: string[]): void {
  let current = state.active;
  let currentWidth = 0;
  let styledLine = state.any;
  let pendingSpace = "";
  let pendingSpaceWidth = 0;
  let word: Piece[] = [];
  let wordWidth = 0;

  const flushLine = (): void => {
    out.push(styledLine ? current + SGR_RESET : current);
    current = state.active;
    currentWidth = 0;
    styledLine = state.any;
  };
  const appendPiece = (piece: Piece): void => {
    if (piece.escape) {
      state.apply(piece.text);
      if (isSgr(piece.text)) styledLine = true;
    }
    current += piece.text;
    currentWidth += piece.width;
  };
  const flushWord = (): void => {
    if (word.length === 0) return;
    // 放不下且整词不超过一行：换行再放；超过一行的长词直接在当前行开始硬断
    const fits = currentWidth + pendingSpaceWidth + wordWidth <= width;
    if (currentWidth > 0 && !fits && wordWidth <= width) {
      flushLine();
      pendingSpace = "";
      pendingSpaceWidth = 0;
    }
    if (currentWidth > 0 || pendingSpaceWidth > 0) {
      if (currentWidth + pendingSpaceWidth <= width) {
        current += pendingSpace;
        currentWidth += pendingSpaceWidth;
      }
    }
    pendingSpace = "";
    pendingSpaceWidth = 0;
    for (const piece of word) {
      if (!piece.escape && currentWidth + piece.width > width && currentWidth > 0) flushLine();
      appendPiece(piece);
    }
    word = [];
    wordWidth = 0;
  };

  for (const piece of pieces(line)) {
    if (piece.escape) {
      word.push(piece);
      continue;
    }
    if (piece.text === " ") {
      flushWord();
      pendingSpace += " ";
      pendingSpaceWidth += 1;
      continue;
    }
    if (piece.width === 2) {
      // 宽字符（中日韩、emoji）之间都可断行
      flushWord();
      word.push(piece);
      wordWidth = 2;
      flushWord();
      continue;
    }
    word.push(piece);
    wordWidth += piece.width;
  }
  flushWord();
  flushLine();
}
