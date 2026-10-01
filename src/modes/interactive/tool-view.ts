/**
 * 工具调用显示（设计 §12.5）。[B7]
 *
 * - 一行标题 `● bash  git status`：圆点运行中为强调色，成功绿、失败红；摘要取最能代表这次调用的参数
 *   （bash 命令、文件路径、搜索模式、task 描述……），路径相对会话 cwd。
 * - 折叠（缺省）：结果前 3 行 + 剩余行数；`edit` 显示 `details.diff`（+/− 着色，前 12 行）；
 *   `bash` 运行中流式显示尾部 8 行；错误红色。`Ctrl+O` 展开全部（上限 400 行）。
 * - 嵌套：带 `parentToolCallId` 的调用（codemode 脚本里的 `tools.*`，B10）挂在外层调用下；折叠时只列
 *   内层调用的标题（最近 5 个），展开时完整显示。
 * - 工具输出先去掉 ANSI 与控制字符、Tab 换成空格，避免打乱布局。
 */

import { isAbsolute, relative } from "node:path";
import type { ToolResult } from "../../tools/types.js";
import {
  stripAnsi,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Theme,
} from "../../tui.js";
import { contentText } from "./message-view.js";

export const COLLAPSED_RESULT_LINES = 3;
export const COLLAPSED_DIFF_LINES = 12;
export const BASH_TAIL_LINES = 8;
export const EXPANDED_MAX_LINES = 400;
export const COLLAPSED_CHILDREN = 5;

export interface ToolViewOptions {
  theme: Theme;
  /** 摘要里的路径相对它显示。 */
  cwd?: string;
}

type ToolState = "running" | "done" | "error";

/** 工具输出 → 可安全显示的行。 */
export function cleanLines(text: string): string[] {
  const clean = stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const lines = clean.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

function flat(text: string, max = 120): string {
  const one = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function displayPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

/** 标题行里的参数摘要。 */
export function toolSummary(name: string, args: unknown, cwd?: string): string {
  if (typeof args !== "object" || args === null) return "";
  const a = args as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof a[key] === "string" && a[key] !== "" ? (a[key] as string) : undefined;
  const path = str("path") ?? str("file_path");
  switch (name) {
    case "bash":
      return flat(str("command") ?? "");
    case "read": {
      if (path === undefined) return "";
      const offset = typeof a["offset"] === "number" ? a["offset"] : undefined;
      const limit = typeof a["limit"] === "number" ? a["limit"] : undefined;
      const range =
        offset !== undefined || limit !== undefined
          ? `:${offset ?? 1}${limit !== undefined ? `+${limit}` : ""}`
          : "";
      return displayPath(path, cwd) + range;
    }
    case "grep":
    case "glob": {
      const pattern = str("pattern") ?? "";
      return path !== undefined ? `${flat(pattern)}  in ${displayPath(path, cwd)}` : flat(pattern);
    }
    case "task":
      return flat(str("description") ?? str("prompt") ?? "");
    default:
      if (path !== undefined) return displayPath(path, cwd);
      for (const key of ["command", "pattern", "description", "query", "url", "name", "code"]) {
        const value = str(key);
        if (value !== undefined) return flat(value);
      }
      return "";
  }
}

function diffOf(result: ToolResult | undefined): string | undefined {
  const details = result?.details;
  if (typeof details !== "object" || details === null) return undefined;
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" && diff !== "" ? diff : undefined;
}

export class ToolView implements Component {
  private state: ToolState = "running";
  private partial = "";
  private result: ToolResult | undefined;
  private expanded = false;
  private readonly nested: ToolView[] = [];
  private cache: { width: number; version: number; lines: string[] } | null = null;
  private version = 0;
  /** 外层调用（嵌套时）：子视图变化要让外层缓存失效。 */
  private parent: ToolView | undefined;

  constructor(
    readonly toolCallId: string,
    readonly toolName: string,
    private readonly args: unknown,
    private readonly options: ToolViewOptions,
  ) {}

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
    this.touch();
  }

  addNested(child: ToolView): void {
    child.setExpanded(this.expanded);
    child.parent = this;
    this.nested.push(child);
    this.touch();
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
    const lines = [this.header(width), ...this.body(width)];
    this.cache = { width, version: this.version, lines };
    return lines;
  }

  header(width: number): string {
    const { theme } = this.options;
    const dot =
      this.state === "running"
        ? theme.fg("accent", "●")
        : this.state === "error"
          ? theme.fg("error", "●")
          : theme.fg("success", "●");
    const summary = toolSummary(this.toolName, this.args, this.options.cwd);
    const title = `${dot} ${theme.bold(theme.fg("tool", this.toolName))}`;
    return truncateToWidth(summary === "" ? title : `${title}  ${summary}`, width);
  }

  private indent(lines: readonly string[], width: number, color?: "dim" | "error"): string[] {
    const { theme } = this.options;
    const inner = Math.max(1, width - 2);
    const out: string[] = [];
    for (const line of lines) {
      const pieces = this.expanded ? wrapTextWithAnsi(line, inner) : [truncateToWidth(line, inner)];
      for (const piece of pieces) out.push("  " + (color ? theme.fg(color, piece) : piece));
    }
    return out;
  }

  private more(hidden: number): string {
    return "  " + this.options.theme.fg("dim", `… 另 ${hidden} 行（Ctrl+O 展开）`);
  }

  private body(width: number): string[] {
    const { theme } = this.options;
    const out: string[] = [];
    // 嵌套调用
    if (this.nested.length > 0) {
      if (this.expanded) {
        for (const child of this.nested) {
          for (const line of child.render(Math.max(1, width - 2))) out.push("  " + line);
        }
      } else {
        const shown = this.nested.slice(-COLLAPSED_CHILDREN);
        if (this.nested.length > shown.length) {
          out.push("  " + theme.fg("dim", `… 前 ${this.nested.length - shown.length} 个调用`));
        }
        for (const child of shown) out.push("  " + child.header(Math.max(1, width - 2)));
      }
    }
    if (this.state === "running") {
      if (this.partial !== "") {
        const all = cleanLines(this.partial);
        const tail = this.expanded ? all.slice(-EXPANDED_MAX_LINES) : all.slice(-BASH_TAIL_LINES);
        out.push(...this.indent(tail, width, "dim"));
      }
      return out;
    }
    const diff = this.state === "done" ? diffOf(this.result) : undefined;
    if (diff !== undefined) {
      const all = cleanLines(diff).filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
      const limit = this.expanded ? EXPANDED_MAX_LINES : COLLAPSED_DIFF_LINES;
      const shown = all.slice(0, limit);
      const inner = Math.max(1, width - 2);
      for (const line of shown) {
        const text = truncateToWidth(line, inner);
        const colored = line.startsWith("+")
          ? theme.fg("success", text)
          : line.startsWith("-")
            ? theme.fg("error", text)
            : line.startsWith("@@")
              ? theme.fg("accent", text)
              : theme.fg("dim", text);
        out.push("  " + colored);
      }
      if (all.length > shown.length) out.push(this.more(all.length - shown.length));
      return out;
    }
    const text = this.result === undefined ? "" : contentText(this.result.content);
    const all = cleanLines(text);
    if (all.length === 0) return out;
    const limit = this.expanded ? EXPANDED_MAX_LINES : COLLAPSED_RESULT_LINES;
    const shown = all.slice(0, limit);
    out.push(...this.indent(shown, width, this.state === "error" ? "error" : "dim"));
    if (all.length > shown.length) out.push(this.more(all.length - shown.length));
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

  /** 新调用；返回视图与它是否是顶层（顶层由调用方加进消息区）。 */
  start(event: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    parentToolCallId?: string;
  }): { view: ToolView; topLevel: boolean } {
    const existing = this.views.get(event.toolCallId);
    if (existing !== undefined) return { view: existing, topLevel: false };
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

  /** 已完成的调用（重放历史）。 */
  completed(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: ToolResult | undefined,
    isError: boolean,
  ): ToolView {
    const { view } = this.start({ toolCallId, toolName, args });
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
