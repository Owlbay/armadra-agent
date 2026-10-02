/**
 * 消息区（设计 §12.5）。[B7]
 *
 * 一个纵向 `Container`，块与块之间空一行（终端界面视觉设计 v1 §1 原则 2：相邻工具调用之间不空行，
 * `ui.compact` 时全部不空行）：
 * - 用户消息 `› 文本`（续行缩进 2 列）；插话 / 之后 / 宿主注入按 `UserMessage.origin` 标
 *   `↳ 插话` / `↳ 之后` / `↳ 宿主`（整行 muted，其它 origin 原样显示）；
 * - 助手消息按内容块渲染：文本走 `Markdown`（`ui.markdown: false` 时纯文本），流式时只改末块
 *   （Markdown 自己按块缓存）；思考块按 `ui.showThinking`：`collapsed`（缺省）一行 `✻ 思考 · N token`
 *   （流式中 `✻ 思考中…`），Ctrl+O 展开为标题 + 缩进 2 列的正文（最多 60 行）；`full` 总是展开且不限行；
 *   `hidden` 不显示；
 * - 压缩摘要卡（左竖条 Card）、重试提示、Hook 阻止提示、宿主 / 系统通知；字形取 `theme.glyphs`；
 * - `replay()` 把已有消息（恢复会话、切换会话、/tree 之后）重新画出来，工具调用交给调用方构造。
 *
 * 滚动交给终端回滚：消息区只追加，切换会话时整体清空重画。
 */

import type { AssistantMessage, ContentBlock, ToolCallBlock, UserMessage } from "../../ai/types.js";
import type { CompactionResult, ToolResultMessage } from "../../agent/types.js";
import type { AgentMessage } from "../../session/types.js";
import {
  Card,
  Container,
  Markdown,
  Spacer,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Theme,
} from "../../tui.js";
import { formatTokens } from "./status-bar.js";

export type ThinkingDisplay = "full" | "collapsed" | "hidden";
export type NoticeLevel = "info" | "warn" | "error";

export interface MessageViewOptions {
  theme: Theme;
  showThinking?: ThinkingDisplay;
  /** false：助手文本不做 Markdown 渲染。 */
  markdown?: boolean;
  /** `ui.compact`：块间不空行。 */
  compact?: boolean;
}

/** 思考块展开时的正文行数上限（`full` 不限）。 */
export const THINKING_EXPANDED_LINES = 60;

/** origin → 中文标签（未知 origin 原样显示）。 */
export const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  steer: "插话",
  followUp: "之后",
  host: "宿主",
};

/** 首行带前缀、续行按 `indent` 缩进的文本（用户消息、排队消息）。 */
export class PrefixedText implements Component {
  private cache: { width: number; lines: string[] } | null = null;

  constructor(
    private readonly prefix: string,
    private readonly body: string,
    private readonly indent = 2,
  ) {}

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const prefixWidth = Math.max(this.indent, visibleWidth(this.prefix));
    const pieces = wrapTextWithAnsi(this.body, Math.max(1, width - prefixWidth));
    const pad = " ".repeat(this.indent);
    const lines = pieces.map((line, i) => (i === 0 ? this.prefix + line : pad + line));
    if (lines.length === 0) lines.push(this.prefix);
    this.cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = null;
  }
}

/** 思考块：折叠一行 / 展开（标题 + 缩进正文）。 */
class ThinkingView implements Component {
  private text = "";
  private tokens = 0;
  private streaming = true;
  private redacted = false;
  private expanded = false;
  private cache: { width: number; lines: string[] } | null = null;

  constructor(
    private readonly theme: Theme,
    private readonly display: ThinkingDisplay,
  ) {}

  set(text: string, tokens: number, streaming: boolean, redacted: boolean): void {
    if (
      text === this.text &&
      tokens === this.tokens &&
      streaming === this.streaming &&
      redacted === this.redacted
    )
      return;
    this.text = text;
    this.tokens = tokens;
    this.streaming = streaming;
    this.redacted = redacted;
    this.cache = null;
  }

  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    this.cache = null;
  }

  private get open(): boolean {
    return !this.redacted && (this.display === "full" || this.expanded);
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const t = this.theme;
    const g = t.glyphs;
    const style = (s: string): string => t.fg("dim", t.italic(s));
    const title = this.streaming
      ? `${g.thinking} 思考中${g.ellipsis}`
      : `${g.thinking} 思考 · ${formatTokens(this.tokens)} token`;
    const lines = [
      style(title) + (this.open && !this.streaming ? "  " + t.fg("dim", g.collapse) : ""),
    ];
    if (this.open && this.text.trim() !== "") {
      const all = this.text
        .trim()
        .split("\n")
        .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)));
      const limit = this.display === "full" ? all.length : THINKING_EXPANDED_LINES;
      for (const line of all.slice(0, limit)) lines.push("  " + t.fg("muted", t.italic(line)));
      if (all.length > limit) {
        lines.push("  " + t.fg("dim", `${g.ellipsis} 另 ${all.length - limit} 行`));
      }
    }
    this.cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = null;
  }
}

/** 粗估 token（4 字符 ≈ 1 token），只用于思考块的流式计数。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contentText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[图片]" : ""))
    .join("");
}

/** 一条助手消息：按内容块（思考 / 文本）同步子组件；工具调用块由 tool-view 单独显示。 */
export class AssistantView extends Container {
  private readonly parts = new Map<number, ThinkingView | Text | Markdown>();
  private readonly status = new Text("");
  private streaming = true;
  private thinkingExpanded = false;

  constructor(private readonly options: MessageViewOptions) {
    super();
  }

  /** Ctrl+O：展开 / 折叠本消息的思考块（`collapsed` 模式下）。 */
  setThinkingExpanded(expanded: boolean): void {
    this.thinkingExpanded = expanded;
    for (const part of this.parts.values()) {
      if (part instanceof ThinkingView) part.setExpanded(expanded);
    }
  }

  update(message: AssistantMessage): void {
    const { theme } = this.options;
    const display = this.options.showThinking ?? "collapsed";
    const order: Component[] = [];
    message.content.forEach((block, index) => {
      if (block.type === "toolCall") return;
      if (block.type === "thinking") {
        if (display === "hidden" || (block.thinking === "" && block.redacted !== true)) return;
        const view = this.part(index, () => {
          const created = new ThinkingView(theme, display);
          created.setExpanded(this.thinkingExpanded);
          return created;
        });
        const single = message.content.filter((b) => b.type === "thinking").length === 1;
        const tokens =
          !this.streaming && single && message.usage.reasoning !== undefined
            ? message.usage.reasoning
            : estimateTokens(block.thinking);
        view.set(block.thinking, tokens, this.streaming, block.redacted === true);
        order.push(view);
        return;
      }
      if (block.text.trim() === "") return;
      const view = this.part(index, () =>
        this.options.markdown === false ? new Text("") : new Markdown("", { theme }),
      );
      if (view.getText() !== block.text) view.setText(block.text);
      order.push(view);
    });
    const gap = this.options.compact !== true;
    this.clear();
    order.forEach((child, i) => {
      if (i > 0 && gap) this.addChild(new Spacer());
      this.addChild(child);
    });
    if (this.status.getText() !== "") {
      if (order.length > 0 && gap) this.addChild(new Spacer());
      this.addChild(this.status);
    }
  }

  /** 收尾：错误 / 中断 / 长度截断提示，思考计数换成用量里的值。 */
  finish(message: AssistantMessage): void {
    this.streaming = false;
    const { theme } = this.options;
    if (message.stopReason === "error") {
      this.status.setText(
        theme.fg("error", `${theme.glyphs.fail} ${message.errorMessage ?? "模型调用失败"}`),
      );
    } else if (message.stopReason === "aborted") {
      this.status.setText(theme.fg("dim", "已中断"));
    } else if (message.stopReason === "length") {
      this.status.setText(theme.fg("warning", "输出达到长度上限"));
    }
    this.update(message);
  }

  get isEmpty(): boolean {
    return this.children.length === 0;
  }

  private part<T extends ThinkingView | Text | Markdown>(index: number, make: () => T): T {
    let part = this.parts.get(index);
    if (part === undefined) {
      part = make();
      this.parts.set(index, part);
    }
    return part as T;
  }
}

export interface ReplayHooks {
  /** 工具调用块 + 配对的结果（可能缺）→ 组件；返回 undefined 不显示。 */
  tool(call: ToolCallBlock, result: ToolResultMessage | undefined): Component | undefined;
}

export class MessageView extends Container {
  private current: AssistantView | undefined;
  private readonly blocks: Component[] = [];
  /** 工具调用块（相邻的不空行）。 */
  private readonly toolBlocks = new WeakSet<Component>();
  private readonly assistants: AssistantView[] = [];
  private thinkingExpanded = false;

  constructor(private readonly options: MessageViewOptions) {
    super();
  }

  private get theme(): Theme {
    return this.options.theme;
  }

  /** 追加一块（与上一块之间空一行；`compact` 不空行）。 */
  add(component: Component): void {
    this.push(component, this.options.compact !== true);
  }

  /** 追加工具调用块：紧跟在另一个工具调用后面时不空行。 */
  addTool(component: Component): void {
    const last = this.blocks[this.blocks.length - 1];
    const gap = this.options.compact !== true && !(last !== undefined && this.toolBlocks.has(last));
    this.toolBlocks.add(component);
    this.push(component, gap);
  }

  private push(component: Component, gap: boolean): void {
    if (this.blocks.length > 0 && gap) this.addChild(new Spacer());
    this.blocks.push(component);
    this.addChild(component);
  }

  /** 去掉一块（空的助手消息等）。 */
  remove(component: Component): void {
    const index = this.blocks.indexOf(component);
    if (index === -1) return;
    this.blocks.splice(index, 1);
    const at = this.children.indexOf(component);
    if (at === -1) return;
    // 连同它前面（首块则是后面）的空行
    if (at > 0 && this.children[at - 1] instanceof Spacer) this.children.splice(at - 1, 2);
    else if (this.children[at + 1] instanceof Spacer) this.children.splice(at, 2);
    else this.children.splice(at, 1);
  }

  reset(): void {
    this.clear();
    this.blocks.length = 0;
    this.assistants.length = 0;
    this.current = undefined;
  }

  get blockCount(): number {
    return this.blocks.length;
  }

  /** Ctrl+O：所有助手消息的思考块一起展开 / 折叠（之后的新消息沿用）。 */
  setThinkingExpanded(expanded: boolean): void {
    this.thinkingExpanded = expanded;
    for (const view of this.assistants) view.setThinkingExpanded(expanded);
  }

  /** 纯文本启动画面（line 模式风格）：首行加粗，其余变暗。交互模式用 StartupHeader。 */
  addHeader(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const [first, ...rest] = lines;
    const text = [this.theme.bold(first ?? ""), ...rest.map((l) => this.theme.fg("dim", l))];
    this.add(new Text(text.join("\n")));
  }

  addUser(message: Pick<UserMessage, "content" | "origin">): void {
    const t = this.theme;
    const text = contentText(message.content).replace(/\s+$/, "");
    const origin = message.origin;
    if (origin === undefined || origin === "user") {
      this.add(new PrefixedText(t.fg("user", t.bold(t.glyphs.prompt)) + " ", text));
      return;
    }
    const label = ORIGIN_LABELS[origin] ?? origin;
    this.add(
      new PrefixedText(
        t.fg("dim", t.glyphs.queued) + " " + t.fg("muted", `${label}  `),
        t.fg("muted", text),
      ),
    );
  }

  private newAssistant(): AssistantView {
    const view = new AssistantView(this.options);
    view.setThinkingExpanded(this.thinkingExpanded);
    this.assistants.push(view);
    return view;
  }

  startAssistant(message: AssistantMessage): AssistantView {
    const view = this.newAssistant();
    view.update(message);
    this.current = view;
    this.add(view);
    return view;
  }

  updateAssistant(message: AssistantMessage): void {
    if (this.current === undefined) this.startAssistant(message);
    else this.current.update(message);
  }

  endAssistant(message: AssistantMessage): void {
    const view = this.current ?? this.startAssistant(message);
    view.finish(message);
    this.current = undefined;
    // 只有工具调用的助手消息不占一块
    if (view.isEmpty) this.remove(view);
  }

  addNotice(level: NoticeLevel, message: string): void {
    const g = this.theme.glyphs;
    const color = level === "error" ? "error" : level === "warn" ? "warning" : "dim";
    const mark = level === "error" ? `${g.fail} ` : level === "warn" ? `${g.warn} ` : "";
    this.add(new Text(this.theme.fg(color, mark + message)));
  }

  addHookBlocked(reason: string): void {
    const glyph = this.theme.glyphs.blocked;
    this.add(new Text(this.theme.fg("warning", `${glyph} Hook 阻止：${reason}`)));
  }

  addRetry(attempt: number, maxAttempts: number, delayMs: number, error: string): void {
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    const glyph = this.theme.glyphs.retry;
    this.add(
      new Text(
        this.theme.fg(
          "warning",
          `${glyph} 重试 ${attempt}/${maxAttempts}（${seconds}s 后）：${error}`,
        ),
      ),
    );
  }

  addRetryFailed(error: string | undefined): void {
    this.addNotice("error", `重试失败${error !== undefined ? `：${error}` : ""}`);
  }

  /** 压缩 / 分支摘要卡（左竖条）：标题 + token 变化（有则显示）+ 摘要前 3 行。 */
  addSummaryCard(
    summary: string,
    options: { title?: string; tokensBefore?: number; tokensAfter?: number } = {},
  ): void {
    const t = this.theme;
    const lines = summary
      .trim()
      .split("\n")
      .filter((l) => l.trim() !== "");
    const head = lines.slice(0, 3);
    const body = head.map((l) => t.fg("muted", l));
    if (lines.length > head.length) {
      body.push(t.fg("dim", `${t.glyphs.ellipsis} 另 ${lines.length - head.length} 行`));
    }
    let subtitle: string | undefined;
    if (options.tokensBefore !== undefined) {
      const after =
        options.tokensAfter !== undefined ? ` → ${formatTokens(options.tokensAfter)}` : "";
      subtitle = `${formatTokens(options.tokensBefore)}${after} token`;
    }
    this.add(
      new Card(new Text(body.join("\n")), {
        theme: t,
        title: options.title ?? "上下文已压缩",
        ...(subtitle !== undefined ? { subtitle } : {}),
      }),
    );
  }

  addCompaction(result: Pick<CompactionResult, "summary" | "tokensBefore" | "tokensAfter">): void {
    this.addSummaryCard(result.summary, {
      tokensBefore: result.tokensBefore,
      ...(result.tokensAfter !== undefined ? { tokensAfter: result.tokensAfter } : {}),
    });
  }

  /** 把已有消息重新画出来。 */
  replay(messages: readonly AgentMessage[], hooks: ReplayHooks): void {
    const results = new Map<string, ToolResultMessage>();
    for (const message of messages) {
      if (message.role === "toolResult") results.set(message.toolCallId, message);
    }
    for (const message of messages) {
      switch (message.role) {
        case "user":
          this.addUser(message);
          break;
        case "assistant": {
          const view = this.newAssistant();
          view.finish(message);
          if (!view.isEmpty) this.add(view);
          for (const block of message.content) {
            if (block.type !== "toolCall") continue;
            const tool = hooks.tool(block, results.get(block.id));
            if (tool !== undefined) this.addTool(tool);
          }
          break;
        }
        case "compactionSummary":
          this.addSummaryCard(message.summary, { tokensBefore: message.tokensBefore });
          break;
        case "branchSummary":
          this.addSummaryCard(message.summary, { title: "分支摘要" });
          break;
        case "custom":
          if (message.display)
            this.add(new Text(this.theme.fg("dim", contentText(message.content))));
          break;
        default:
          break;
      }
    }
  }
}
