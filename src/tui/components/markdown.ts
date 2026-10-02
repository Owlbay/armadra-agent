/**
 * Markdown → 行（设计 §12.5）。[B4]
 *
 * 支持：ATX 标题、段落（软换行合并为空格，行尾两个空格或 `\` 为硬换行）、无序 / 有序列表（缩进嵌套）、
 * 围栏代码块（边框 + 语言标签；流式时未闭合的围栏按代码块渲染）、引用、分隔线、
 * 行内 `code` / **粗体** / *斜体* / ~~删除线~~ / [链接](url) / <自动链接> / 反斜杠转义。
 * 表格降级为等宽对齐文本（不换行、超宽截断）；不做语法高亮（§12.9）。
 *
 * 缓存：按块缓存渲染结果（键 = 宽度 + 块源文本），流式追加时只有末块重新渲染；解析也是增量的
 * （`Markdown.append` 只从尾部可能变化的块重新解析）。
 */

import type { Component, Theme } from "../component.js";
import { padToWidth, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../ansi.js";
import { plainTheme } from "../theme.js";

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string; source: string }
  | { kind: "paragraph"; text: string; source: string }
  | { kind: "code"; lang: string; lines: string[]; source: string }
  | { kind: "list"; items: ListItem[]; source: string }
  | { kind: "quote"; text: string; source: string }
  | { kind: "table"; rows: string[][]; source: string }
  | { kind: "hr"; source: string };

export interface ListItem {
  depth: number;
  marker: string;
  text: string;
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isBlockStart(line: string): boolean {
  return (
    HEADING_RE.test(line) ||
    FENCE_RE.test(line) ||
    HR_RE.test(line) ||
    LIST_RE.test(line) ||
    QUOTE_RE.test(line) ||
    TABLE_RE.test(line)
  );
}

function splitLines(source: string): string[] {
  return source.replace(/\r\n?/g, "\n").split("\n");
}

/** 块占的行区间 [start, end)（行号，相对整篇）。 */
export interface BlockSpan {
  start: number;
  end: number;
}

/** 把源文本切成块。 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseLines(splitLines(source), 0, [], []);
}

/**
 * 从第 `from` 行起解析，块与行区间分别追加到 `blocks` / `spans`。块与块之间不带状态（空行跳过），
 * 所以从任一块的起始行重新解析，结果与全量解析的对应部分相同（增量解析的前提）。
 */
function parseLines(
  lines: string[],
  from: number,
  blocks: MarkdownBlock[],
  spans: BlockSpan[],
): MarkdownBlock[] {
  let i = from;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const start = i;
    const before = blocks.length;
    i = parseBlock(lines, i, blocks);
    for (let k = before; k < blocks.length; k++) spans.push({ start, end: i });
  }
  return blocks;
}

/** 解析从 `i` 起（非空行）的一个块，返回下一行号。 */
function parseBlock(lines: string[], i: number, blocks: MarkdownBlock[]): number {
  const line = lines[i]!;
  const start = i;
  const fence = FENCE_RE.exec(line);
  if (fence) {
    const marker = fence[1]!;
    const body: string[] = [];
    i++;
    while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) body.push(lines[i++]!);
    if (i < lines.length) i++;
    const src = lines.slice(start, i).join("\n");
    blocks.push({ kind: "code", lang: fence[2] ?? "", lines: body, source: src });
    return i;
  }
  const heading = HEADING_RE.exec(line);
  if (heading) {
    blocks.push({
      kind: "heading",
      level: heading[1]!.length,
      text: heading[2] ?? "",
      source: line,
    });
    i++;
    return i;
  }
  if (HR_RE.test(line)) {
    blocks.push({ kind: "hr", source: line });
    i++;
    return i;
  }
  if (TABLE_RE.test(line)) {
    const rows: string[][] = [];
    while (i < lines.length && TABLE_RE.test(lines[i]!)) {
      const row = lines[i++]!;
      if (TABLE_SEP_RE.test(row)) continue;
      rows.push(splitTableRow(row));
    }
    blocks.push({ kind: "table", rows, source: lines.slice(start, i).join("\n") });
    return i;
  }
  if (QUOTE_RE.test(line)) {
    const body: string[] = [];
    while (i < lines.length && QUOTE_RE.test(lines[i]!)) body.push(QUOTE_RE.exec(lines[i++]!)![1]!);
    blocks.push({
      kind: "quote",
      text: body.join("\n"),
      source: lines.slice(start, i).join("\n"),
    });
    return i;
  }
  if (LIST_RE.test(line)) {
    return parseList(lines, i, blocks);
  }
  const body: string[] = [line];
  i++;
  while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) {
    body.push(lines[i++]!);
  }
  blocks.push({ kind: "paragraph", text: joinSoftBreaks(body), source: body.join("\n") });
  return i;
}

function parseList(lines: string[], start: number, blocks: MarkdownBlock[]): number {
  const items: ListItem[] = [];
  const indents: number[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = LIST_RE.exec(line);
    if (m) {
      const indent = m[1]!.replace(/\t/g, "    ").length;
      while (indents.length > 0 && indent < indents[indents.length - 1]!) indents.pop();
      if (indents.length === 0 || indent > indents[indents.length - 1]!) indents.push(indent);
      items.push({ depth: indents.length - 1, marker: m[2]!, text: m[3]! });
      i++;
      continue;
    }
    // 续行：缩进的非空行并入上一项；空行后接列表项则继续，否则结束
    if (line.trim() !== "" && /^\s+/.test(line) && items.length > 0) {
      const last = items[items.length - 1]!;
      last.text = joinSoftBreaks([last.text, line.trim()]);
      i++;
      continue;
    }
    if (line.trim() === "" && i + 1 < lines.length && LIST_RE.test(lines[i + 1]!)) {
      i++;
      continue;
    }
    break;
  }
  blocks.push({ kind: "list", items, source: lines.slice(start, i).join("\n") });
  return i;
}

function joinSoftBreaks(lines: string[]): string {
  let out = "";
  lines.forEach((line, index) => {
    const text = index === lines.length - 1 ? line.trim() : line.trimStart();
    if (index === 0) {
      out = text;
      return;
    }
    const hard = / {2,}$/.test(out) || out.endsWith("\\");
    out = out.replace(/(?: {2,}|\\)$/, "").trimEnd() + (hard ? "\n" : " ") + text;
  });
  return out.trimEnd();
}

function splitTableRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** 行内标记 → 带样式文本。 */
export function renderInline(text: string, theme: Theme): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!~|<>]/.test(text[i + 1]!)) {
      out += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const ticks = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end !== -1) {
        out += theme.fg("code", text.slice(i + ticks.length, end).trim() || " ");
        i = end + ticks.length;
        continue;
      }
    }
    const emphasis = matchDelimited(text, i, ["**", "__", "~~", "*", "_"]);
    if (emphasis) {
      const inner = renderInline(emphasis.inner, theme);
      if (emphasis.delim === "**" || emphasis.delim === "__") out += theme.bold(inner);
      else if (emphasis.delim === "~~") out += `\x1b[9m${inner}\x1b[29m`;
      else out += theme.italic(inner);
      i = emphasis.end;
      continue;
    }
    if (ch === "[") {
      const link = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(text.slice(i));
      if (link) {
        const label = renderInline(link[1]!, theme);
        const url = link[2]!;
        out +=
          link[1] === url || url === ""
            ? theme.underline(label || url)
            : theme.underline(label) + theme.fg("dim", ` (${url})`);
        i += link[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const auto = /^<((?:https?|mailto):[^>\s]+)>/.exec(text.slice(i));
      if (auto) {
        out += theme.underline(auto[1]!);
        i += auto[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function matchDelimited(
  text: string,
  i: number,
  delims: readonly string[],
): { delim: string; inner: string; end: number } | null {
  for (const delim of delims) {
    if (!text.startsWith(delim, i)) continue;
    const after = text[i + delim.length];
    if (after === undefined || /\s/.test(after)) continue;
    // 下划线只在词边界起作用（snake_case 不当斜体）
    if (delim.startsWith("_") && i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1]!)) continue;
    let search = i + delim.length + 1;
    while (search <= text.length) {
      const close = text.indexOf(delim, search);
      if (close === -1) break;
      const before = text[close - 1]!;
      const next = text[close + delim.length];
      const wordAfter = next !== undefined && /[\p{L}\p{N}]/u.test(next);
      if (!/\s/.test(before) && !(delim.startsWith("_") && wordAfter)) {
        // `*` 不吃 `**` 的一半
        if (delim.length === 1 && text[close + 1] === delim) {
          search = close + 2;
          continue;
        }
        return { delim, inner: text.slice(i + delim.length, close), end: close + delim.length };
      }
      search = close + 1;
    }
  }
  return null;
}

/** 单个块 → 行（不含块间空行）。 */
export function renderBlock(block: MarkdownBlock, width: number, theme: Theme): string[] {
  switch (block.kind) {
    case "heading": {
      const text = renderInline(block.text, theme);
      const styled = block.level <= 2 ? theme.fg("accent", theme.bold(text)) : theme.bold(text);
      return wrapTextWithAnsi(styled, width);
    }
    case "paragraph":
      return wrapTextWithAnsi(renderInline(block.text, theme), width);
    case "hr":
      return [theme.fg("border", "─".repeat(Math.max(1, width)))];
    case "quote": {
      const bar = theme.fg("border", "│ ");
      const inner = wrapTextWithAnsi(theme.italic(renderInline(block.text, theme)), width - 2);
      return inner.map((line) => bar + line);
    }
    case "list":
      return renderList(block.items, width, theme);
    case "code":
      return renderCode(block.lang, block.lines, width, theme);
    case "table":
      return renderTable(block.rows, width, theme);
  }
}

const BULLETS = ["•", "◦", "▪"];

function renderList(items: readonly ListItem[], width: number, theme: Theme): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const indent = "  ".repeat(item.depth);
    const ordered = /\d/.test(item.marker);
    const bullet = ordered ? item.marker : BULLETS[item.depth % BULLETS.length]!;
    const head = indent + theme.fg("accent", bullet) + " ";
    const headWidth = visibleWidth(head);
    const body = wrapTextWithAnsi(renderInline(item.text, theme), Math.max(1, width - headWidth));
    body.forEach((line, index) => {
      lines.push((index === 0 ? head : " ".repeat(headWidth)) + line);
    });
  }
  return lines;
}

function renderCode(lang: string, body: readonly string[], width: number, theme: Theme): string[] {
  const code = body.map((line) => line.replace(/\t/g, "    "));
  if (width < 8) return code.map((line) => truncateToWidth(line, width));
  const inner = width - 4;
  const border = (s: string): string => theme.fg("border", s);
  const label = lang === "" ? "" : truncateToWidth(` ${lang} `, inner - 1);
  const top =
    border("╭─") +
    theme.fg("dim", label) +
    border("─".repeat(width - 3 - visibleWidth(label)) + "╮");
  const lines = [top];
  for (const line of code) {
    for (const piece of wrapCode(line, inner)) {
      lines.push(border("│ ") + padToWidth(theme.fg("code", piece), inner) + border(" │"));
    }
  }
  lines.push(border("╰" + "─".repeat(width - 2) + "╯"));
  return lines;
}

/** 代码按列硬断行（不按词），空行保留。 */
function wrapCode(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const out: string[] = [];
  let current = "";
  let w = 0;
  for (const ch of line) {
    const cw = visibleWidth(ch);
    if (w + cw > width) {
      out.push(current);
      current = "";
      w = 0;
    }
    current += ch;
    w += cw;
  }
  out.push(current);
  return out;
}

function renderTable(rows: readonly string[][], width: number, theme: Theme): string[] {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const widths = new Array<number>(cols).fill(0);
  const rendered = rows.map((row) => row.map((cell) => renderInline(cell, theme)));
  for (const row of rendered) {
    row.forEach((cell, c) => (widths[c] = Math.max(widths[c]!, visibleWidth(cell))));
  }
  const sep = theme.fg("border", " │ ");
  return rendered.map((row, r) => {
    const cells = widths.map((w, c) => padToWidth(row[c] ?? "", w));
    const line = cells.join(sep).replace(/\s+$/, "");
    return truncateToWidth(r === 0 && rows.length > 1 ? theme.bold(line) : line, width);
  });
}

export interface MarkdownOptions {
  theme?: Theme;
  /** 左右内边距。 */
  paddingX?: number;
}

export class Markdown implements Component {
  private blocks: MarkdownBlock[] = [];
  /** 与 blocks 一一对应的行区间（增量解析用）。 */
  private spans: BlockSpan[] = [];
  /** 规范化（\r\n → \n）后的行。 */
  private lines: string[] = [];
  private cacheWidth = -1;
  private readonly blockCache = new Map<string, string[]>();
  private lastLines: string[] | null = null;
  private readonly theme: Theme;
  /** 累计解析过的行数（诊断与测试：流式追加应只重解析尾部）。 */
  parsedLines = 0;

  constructor(
    private text = "",
    private readonly options: MarkdownOptions = {},
  ) {
    this.theme = options.theme ?? plainTheme();
    this.reparseFrom(0, splitLines(text));
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    if (text === this.text) return;
    if (text.startsWith(this.text) && this.text !== "") {
      this.append(text.slice(this.text.length));
      return;
    }
    this.text = text;
    this.reparseFrom(0, splitLines(text));
  }

  /**
   * 流式追加：只有最后一行会变长，此前的行不变。一个块的结束取决于它之后的一行（列表再多看一行），
   * 所以「结束行 + 1」早于旧的最后一行的块保持不变，从第一个不满足的块的起始行重新解析
   * （未闭合的围栏就是从围栏起点）。含 `\r` 时回落全量（`\r\n` 可能被拆在两次追加之间）。
   */
  append(delta: string): void {
    if (delta === "") return;
    const previous = this.text;
    this.text = previous + delta;
    if (delta.includes("\r") || previous.endsWith("\r")) {
      this.reparseFrom(0, splitLines(this.text));
      return;
    }
    const lines = this.lines;
    const oldLast = lines.length - 1;
    const pieces = delta.split("\n");
    lines[oldLast] = (lines[oldLast] ?? "") + pieces[0]!;
    for (let k = 1; k < pieces.length; k++) lines.push(pieces[k]!);
    let keep = this.spans.findIndex((span) => span.end + 1 >= oldLast);
    if (keep === -1) keep = this.spans.length;
    const from = keep < this.spans.length ? this.spans[keep]!.start : (this.spans.at(-1)?.end ?? 0);
    this.blocks.length = keep;
    this.spans.length = keep;
    this.reparseFrom(from, lines);
  }

  private reparseFrom(from: number, lines: string[]): void {
    if (from === 0) {
      this.blocks = [];
      this.spans = [];
    }
    this.lines = lines;
    parseLines(lines, from, this.blocks, this.spans);
    this.parsedLines += lines.length - from;
    this.lastLines = null;
  }

  render(width: number): string[] {
    if (width !== this.cacheWidth) {
      this.blockCache.clear();
      this.cacheWidth = width;
      this.lastLines = null;
    }
    if (this.lastLines) return this.lastLines;
    const padX = this.options.paddingX ?? 0;
    const inner = Math.max(1, width - padX * 2);
    const pad = " ".repeat(padX);
    const lines: string[] = [];
    const used = new Set<string>();
    this.blocks.forEach((block, index) => {
      const key = `${block.kind}\u0000${block.source}`;
      used.add(key);
      let rendered = this.blockCache.get(key);
      if (!rendered) {
        rendered = renderBlock(block, inner, this.theme).map((line) => pad + line);
        this.blockCache.set(key, rendered);
      }
      if (index > 0) lines.push("");
      for (const line of rendered) lines.push(line);
    });
    for (const key of [...this.blockCache.keys()]) if (!used.has(key)) this.blockCache.delete(key);
    this.lastLines = lines;
    return lines;
  }

  invalidate(): void {
    this.blockCache.clear();
    this.lastLines = null;
  }
}
