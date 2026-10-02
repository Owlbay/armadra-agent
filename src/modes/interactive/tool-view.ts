/**
 * 工具调用显示（设计 §12.5；终端界面视觉设计 v1 §3.5）。[B7]
 *
 * 三级层级，用缩进表达：
 * ```
 * ⏺ read src/tui/tui.ts:1+120          第 0 列：⏺（运行中 accent、成功 success、失败 error）+ 工具名 + 摘要
 *   ⎿ 读取 120 行                       第 2 列：⎿ + 一行结果摘要（tool-summary.ts）
 *          1  /**                        第 4 列：输出正文
 *     … 另 117 行（Ctrl+O 展开）
 * ```
 * - 运行中摘要行 `⎿ ⠋ 运行中 · 4s`：spinner 与底部 Loader 同帧（ToolTracker.tick 由 Loader.onFrame 驱动），
 *   标题行不变；bash 流式显示尾部 8 行（muted）。task 显示 `子 Agent · 运行中 1m05s`。
 * - 折叠（缺省）：结果前 3 行；edit 显示 `details.diff`（`@@` dim、`+` success、`-` error、上下文 muted，
 *   宽 ≥ 60 时带行号列），前 12 行；`Ctrl+O` 展开全部（上限 400 行，长行折行）。
 * - 嵌套：带 `parentToolCallId` 的调用（codemode 脚本里的 `tools.*`）挂在外层调用下、右移 4 列；折叠时只列
 *   最近 5 个内层调用的标题与摘要行，展开时完整显示。
 * - 工具输出先去掉 ANSI 与控制字符、Tab 换成空格，避免打乱布局。
 * - 自定义渲染（`ToolDefinition.renderCall / renderResult`）：标题摘要优先取 `renderCall` 第一行；成功的结果
 *   正文优先用 `renderResult`；抛错或返回空时回到缺省显示；错误结果始终用缺省显示。
 */

import type { ToolDefinition, ToolResult } from "../../tools/types.js";
import {
  formatElapsed,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type SemanticColor,
  type Theme,
} from "../../tui.js";
import { contentText } from "./message-view.js";
import {
  bashOutput,
  cleanLines,
  diffOf,
  flat,
  parseDiff,
  resultSummary,
  toolSummary,
  type DiffRow,
} from "./tool-summary.js";

export { cleanLines, toolSummary } from "./tool-summary.js";

export const COLLAPSED_RESULT_LINES = 3;
export const COLLAPSED_DIFF_LINES = 12;
export const BASH_TAIL_LINES = 8;
export const EXPANDED_MAX_LINES = 400;
export const COLLAPSED_CHILDREN = 5;
/** 正文缩进（第 4 列）。 */
const BODY = "    ";
/** diff 行号列的最小显示宽度。 */
const DIFF_NUMBERS_MIN_WIDTH = 60;

export interface ToolViewOptions {
  theme: Theme;
  /** 摘要里的路径相对它显示。 */
  cwd?: string;
  /** 取工具定义（自定义渲染用）；缺省或取不到时用内置摘要与结果显示。 */
  getTool?(name: string): ToolDefinition | undefined;
  /** 计时（耗时与运行中秒数）；缺省 Date.now。 */
  now?(): number;
  /** 运行中摘要行的 spinner 帧（与 Loader 同帧）；缺省静态字形。 */
  spinner?(): string;
}

type ToolState = "running" | "done" | "error";

export class ToolView implements Component {
  private state: ToolState = "running";
  private partial = "";
  private result: ToolResult | undefined;
  private expanded = false;
  private readonly nested: ToolView[] = [];
  private cache: { width: number; version: number; lines: string[] } | null = null;
  private version = 0;
  private readonly startedAt: number;
  private elapsedMs = 0;
  /** 重放的历史调用（没有真实耗时）。 */
  replayed = false;
  /** 外层调用（嵌套时）：子视图变化要让外层缓存失效。 */
  private parent: ToolView | undefined;

  constructor(
    readonly toolCallId: string,
    readonly toolName: string,
    private readonly args: unknown,
    private readonly options: ToolViewOptions,
  ) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get isRunning(): boolean {
    return this.state === "running";
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  get children(): readonly ToolView[] {
    return this.nested;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const child of this.nested) child.setExpanded(expanded);
    this.touch();
  }

  /** 运行中的输出（滚动尾部，整体替换）。 */
  update(partial: string): void {
    this.partial = partial;
    this.touch();
  }

  finish(result: ToolResult, isError: boolean): void {
    this.result = result;
    this.state = isError || result.isError === true ? "error" : "done";
    this.elapsedMs = this.now() - this.startedAt;
    this.touch();
  }

  addNested(child: ToolView): void {
    child.setExpanded(this.expanded);
    child.parent = this;
    this.nested.push(child);
    this.touch();
  }

  /** spinner 换帧 / 秒数变化：运行中的视图重画摘要行。 */
  tick(): void {
    if (this.state === "running") this.touch();
  }

  private touch(): void {
    this.version++;
    this.parent?.touch();
  }

  invalidate(): void {
    this.cache = null;
    for (const child of this.nested) child.invalidate();
  }

  render(width: number): string[] {
    if (this.cache && this.cache.width === width && this.cache.version === this.version) {
      return this.cache.lines;
    }
    const lines = [this.header(width), this.summaryLine(width), ...this.body(width)].filter(
      (line): line is string => line !== undefined,
    );
    this.cache = { width, version: this.version, lines };
    return lines;
  }

  header(width: number): string {
    const { theme } = this.options;
    const color: SemanticColor =
      this.state === "running" ? "accent" : this.state === "error" ? "error" : "success";
    const dot = theme.fg(color, theme.glyphs.tool);
    const summary =
      this.customCall(width) ?? toolSummary(this.toolName, this.args, this.options.cwd);
    const title = `${dot} ${theme.bold(theme.fg("tool", this.toolName))}`;
    return truncateToWidth(summary === "" ? title : `${title} ${summary}`, width);
  }

  /** `  ⎿ 摘要`：运行中带 spinner 与秒数，完成后是结果摘要。 */
  summaryLine(width: number): string | undefined {
    const { theme } = this.options;
    const g = theme.glyphs;
    const lead = "  " + theme.fg("border", g.result) + " ";
    if (this.state === "running") {
      const frame = this.options.spinner?.() ?? g.spinnerStatic;
      const elapsed = formatElapsed(this.now() - this.startedAt);
      const what =
        this.toolName === "task" ? `子 Agent · 运行中 ${elapsed}` : `运行中 · ${elapsed}`;
      return truncateToWidth(
        lead + theme.fg("accent", frame) + " " + theme.fg("muted", what),
        width,
      );
    }
    const result = this.result!;
    const text = resultSummary(
      {
        name: this.toolName,
        args: this.args,
        result,
        isError: this.state === "error",
        lines: this.resultLines(),
        elapsedMs: this.replayed ? undefined : this.elapsedMs,
        nestedCount: this.nested.length,
      },
      theme,
    );
    return truncateToWidth(lead + text, width);
  }

  private custom<T>(render: (tool: ToolDefinition) => T): T | undefined {
    const tool = this.options.getTool?.(this.toolName);
    if (tool === undefined) return undefined;
    try {
      return render(tool);
    } catch {
      return undefined;
    }
  }

  /** `renderCall` 的第一行（去控制字符、折叠空白）；没有或为空时 undefined。 */
  private customCall(width: number): string | undefined {
    const first = this.custom((tool) => tool.renderCall?.(this.args, width)?.[0]);
    if (typeof first !== "string") return undefined;
    const line = flat(cleanLines(first).join(" "));
    return line === "" ? undefined : line;
  }

  /** 成功结果的 `renderResult` 行；没有或为空时 undefined。 */
  private customResult(width: number): string[] | undefined {
    const result = this.result;
    if (result === undefined || this.state !== "done") return undefined;
    const inner = Math.max(1, width - BODY.length);
    const rendered = this.custom((tool) => tool.renderResult?.(result, inner, this.expanded));
    if (!Array.isArray(rendered) || rendered.length === 0) return undefined;
    return rendered
      .slice(0, EXPANDED_MAX_LINES)
      .map((line) => BODY + truncateToWidth(cleanLines(String(line)).join(" "), inner));
  }

  /** 完成后的结果正文（已清洗）：bash 取 `details.output`。 */
  private resultLines(): string[] {
    const result = this.result;
    if (result === undefined) return [];
    if (this.toolName === "bash") {
      const output = bashOutput(result);
      if (output !== undefined) return cleanLines(output);
    }
    return cleanLines(contentText(result.content));
  }

  private indent(lines: readonly string[], width: number, color?: SemanticColor): string[] {
    const { theme } = this.options;
    const inner = Math.max(1, width - BODY.length);
    const out: string[] = [];
    for (const line of lines) {
      const pieces = this.expanded ? wrapTextWithAnsi(line, inner) : [truncateToWidth(line, inner)];
      for (const piece of pieces) out.push(BODY + (color ? theme.fg(color, piece) : piece));
    }
    return out;
  }

  private more(hidden: number): string {
    const { theme } = this.options;
    return BODY + theme.fg("dim", `${theme.glyphs.ellipsis} 另 ${hidden} 行（Ctrl+O 展开）`);
  }

  private nestedLines(width: number): string[] {
    const { theme } = this.options;
    if (this.nested.length === 0) return [];
    const inner = Math.max(1, width - BODY.length);
    const out: string[] = [];
    if (this.expanded) {
      for (const child of this.nested) {
        for (const line of child.render(inner)) out.push(BODY + line);
      }
      return out;
    }
    const shown = this.nested.slice(-COLLAPSED_CHILDREN);
    if (this.nested.length > shown.length) {
      const hidden = this.nested.length - shown.length;
      out.push(BODY + theme.fg("dim", `${theme.glyphs.ellipsis} 前 ${hidden} 个调用`));
    }
    for (const child of shown) {
      out.push(BODY + child.header(inner));
      const summary = child.summaryLine(inner);
      if (summary !== undefined) out.push(BODY + summary);
    }
    return out;
  }

  private body(width: number): string[] {
    const out = this.nestedLines(width);
    if (this.state === "running") {
      if (this.partial !== "") {
        const all = cleanLines(this.partial);
        const tail = this.expanded ? all.slice(-EXPANDED_MAX_LINES) : all.slice(-BASH_TAIL_LINES);
        out.push(...this.indent(tail, width, "muted"));
      }
      return out;
    }
    const custom = this.customResult(width);
    if (custom !== undefined) return [...out, ...custom];
    const diff = this.state === "done" ? diffOf(this.result) : undefined;
    if (diff !== undefined) return [...out, ...this.diffLines(parseDiff(diff), width)];
    let all = this.resultLines();
    // 非 bash 的失败：首行已在摘要里
    if (this.state === "error" && this.toolName !== "bash") all = all.slice(1);
    if (all.length === 0) return out;
    const limit = this.expanded ? EXPANDED_MAX_LINES : COLLAPSED_RESULT_LINES;
    const shown = all.slice(0, limit);
    if (this.state === "error") out.push(...this.indent(shown, width, "error"));
    else if (this.toolName === "read") out.push(...this.readLines(shown, width));
    else if (this.toolName === "grep") out.push(...this.grepLines(shown, width));
    else out.push(...this.indent(shown, width, "muted"));
    if (all.length > shown.length) out.push(this.more(all.length - shown.length));
    return out;
  }

  /** read：行号右对齐（按最长行号，至少 3 位）dim，与正文隔两格。 */
  private readLines(lines: readonly string[], width: number): string[] {
    const { theme } = this.options;
    const parsed = lines.map((line) => /^\s*(\d+) {4}(.*)$/.exec(line));
    const numWidth = Math.max(3, ...parsed.map((m) => (m ? m[1]!.length : 0)));
    const styled = lines.map((line, i) => {
      const m = parsed[i];
      return m ? theme.fg("dim", m[1]!.padStart(numWidth)) + "  " + m[2]! : line;
    });
    return this.indent(styled, width);
  }

  /** grep：路径正文色，`:行号:` dim，命中片段 muted。 */
  private grepLines(lines: readonly string[], width: number): string[] {
    const { theme } = this.options;
    const styled = lines.map((line) => {
      const m = /^(.+?)(:\d+:)(.*)$/.exec(line);
      return m
        ? m[1]! + theme.fg("dim", m[2]!) + theme.fg("muted", m[3]!)
        : theme.fg("muted", line);
    });
    return this.indent(styled, width);
  }

  private diffLines(rows: readonly DiffRow[], width: number): string[] {
    const { theme } = this.options;
    const limit = this.expanded ? EXPANDED_MAX_LINES : COLLAPSED_DIFF_LINES;
    const shown = rows.slice(0, limit);
    const numbers = width >= DIFF_NUMBERS_MIN_WIDTH;
    const numWidth = Math.max(3, ...shown.map((r) => String(r.num ?? "").length));
    const color: Record<DiffRow["kind"], SemanticColor> = {
      hunk: "dim",
      add: "success",
      del: "error",
      ctx: "muted",
    };
    const styled = shown.map((row) => {
      if (!numbers || row.kind === "hunk") return theme.fg(color[row.kind], row.text);
      const no = theme.fg("dim", String(row.num ?? "").padStart(numWidth));
      return `${no} ${theme.fg(color[row.kind], row.text)}`;
    });
    const out = this.indent(styled, width);
    if (rows.length > shown.length) out.push(this.more(rows.length - shown.length));
    return out;
  }
}

/** 按 toolCallId 管理视图与嵌套；`Ctrl+O` 的全局展开状态也在这里。 */
export class ToolTracker {
  private readonly views = new Map<string, ToolView>();
  private expanded = false;

  constructor(private readonly options: ToolViewOptions) {}

  get isExpanded(): boolean {
    return this.expanded;
  }

  get(toolCallId: string): ToolView | undefined {
    return this.views.get(toolCallId);
  }

  /** 运行中的调用数（Loader 动词用）。 */
  running(): ToolView[] {
    return [...this.views.values()].filter((view) => view.isRunning);
  }

  /** 新调用；返回视图与它是否是顶层（顶层由调用方加进消息区）。 */
  start(event: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    parentToolCallId?: string;
  }): { view: ToolView; topLevel: boolean } {
    const existing = this.views.get(event.toolCallId);
    // 同一调用的重复 start 复用；已结束的同名 id（有的供应商跨回合复用 id）另起一个视图
    if (existing !== undefined && existing.isRunning) return { view: existing, topLevel: false };
    const view = new ToolView(event.toolCallId, event.toolName, event.args, this.options);
    view.setExpanded(this.expanded);
    this.views.set(event.toolCallId, view);
    const parent =
      event.parentToolCallId !== undefined ? this.views.get(event.parentToolCallId) : undefined;
    if (parent !== undefined) {
      parent.addNested(view);
      return { view, topLevel: false };
    }
    return { view, topLevel: true };
  }

  update(toolCallId: string, partial: string): void {
    this.views.get(toolCallId)?.update(partial);
  }

  end(toolCallId: string, result: ToolResult, isError: boolean): void {
    this.views.get(toolCallId)?.finish(result, isError);
  }

  /** Loader 换帧：运行中的视图重画摘要行。 */
  tick(): void {
    for (const view of this.views.values()) view.tick();
  }

  /** 已完成的调用（重放历史）。 */
  completed(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: ToolResult | undefined,
    isError: boolean,
  ): ToolView {
    const { view } = this.start({ toolCallId, toolName, args });
    view.replayed = true;
    if (result !== undefined) view.finish(result, isError);
    return view;
  }

  /** Ctrl+O：切换全部调用的展开状态。 */
  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    for (const view of this.views.values()) view.setExpanded(this.expanded);
    return this.expanded;
  }

  clear(): void {
    this.views.clear();
  }
}
