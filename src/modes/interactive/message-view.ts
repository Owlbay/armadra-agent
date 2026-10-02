/**
 * 消息区（设计 §12.5）。[B7]
 *
 * 一个纵向 `Container`，块与块之间空一行：
 * - 用户消息 `› 文本`；steer / followUp / 宿主注入按 `UserMessage.origin` 标 `↳ steer` / `↳ host` …；
 * - 助手消息按内容块渲染：文本走 `Markdown`（`ui.markdown: false` 时纯文本），流式时只改末块
 *   （Markdown 自己按块缓存）；思考块按 `ui.showThinking`：`collapsed`（缺省）一行 `思考 · N token`、
 *   `full` 显示全文、`hidden` 不显示；
 * - 压缩摘要卡、重试提示、Hook 阻止提示、宿主 / 系统通知；
 * - `replay()` 把已有消息（恢复会话、切换会话、/tree 之后）重新画出来，工具调用交给调用方构造。
 *
 * 滚动交给终端回滚：消息区只追加，切换会话时整体清空重画。
 */

import type { AssistantMessage, ContentBlock, ToolCallBlock, UserMessage } from "../../ai/types.js";
import type { CompactionResult, ToolResultMessage } from "../../agent/types.js";
import type { AgentMessage } from "../../session/types.js";
import { Box, Container, Markdown, Spacer, Text, type Component, type Theme } from "../../tui.js";

export type ThinkingDisplay = "full" | "collapsed" | "hidden";
export type NoticeLevel = "info" | "warn" | "error";

export interface MessageViewOptions {
  theme: Theme;
  showThinking?: ThinkingDisplay;
  /** false：助手文本不做 Markdown 渲染。 */
  markdown?: boolean;
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
  private readonly parts = new Map<number, Text | Markdown>();
  private readonly status = new Text("");
  private streaming = true;

  constructor(private readonly options: MessageViewOptions) {
    super();
  }

  update(message: AssistantMessage): void {
    const { theme } = this.options;
    const display = this.options.showThinking ?? "collapsed";
    const order: Component[] = [];
    message.content.forEach((block, index) => {
      if (block.type === "toolCall") return;
      if (block.type === "thinking") {
        if (display === "hidden" || (block.thinking === "" && block.redacted !== true)) return;
        const text = this.part(index, () => new Text(""));
        if (display === "full" && block.redacted !== true) {
          text.setText(theme.fg("dim", theme.italic(block.thinking.trim())));
        } else {
          const single = message.content.filter((b) => b.type === "thinking").length === 1;
          const tokens =
            !this.streaming && single && message.usage.reasoning !== undefined
              ? message.usage.reasoning
              : estimateTokens(block.thinking);
          text.setText(theme.fg("dim", `${this.streaming ? "思考…" : "思考 ·"} ${tokens} token`));
        }
        order.push(text);
        return;
      }
      if (block.text.trim() === "") return;
      const view = this.part(index, () =>
        this.options.markdown === false ? new Text("") : new Markdown("", { theme }),
      );
      if (view.getText() !== block.text) view.setText(block.text);
      order.push(view);
    });
    this.clear();
    order.forEach((child, i) => {
      if (i > 0) this.addChild(new Spacer());
      this.addChild(child);
    });
    if (this.status.getText() !== "") {
      if (order.length > 0) this.addChild(new Spacer());
      this.addChild(this.status);
    }
  }

  /** 收尾：错误 / 中断 / 长度截断提示，思考计数换成用量里的值。 */
  finish(message: AssistantMessage): void {
    this.streaming = false;
    const { theme } = this.options;
    if (message.stopReason === "error") {
      this.status.setText(theme.fg("error", `✗ ${message.errorMessage ?? "模型调用失败"}`));
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

  private part<T extends Text | Markdown>(index: number, make: () => T): T {
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

  constructor(private readonly options: MessageViewOptions) {
    super();
  }

  private get theme(): Theme {
    return this.options.theme;
  }

  /** 追加一块（与上一块之间空一行）。 */
  add(component: Component): void {
    if (this.blocks.length > 0) this.addChild(new Spacer());
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
    this.current = undefined;
  }

  get blockCount(): number {
    return this.blocks.length;
  }

  /** 启动画面：首行加粗，其余变暗。 */
  addHeader(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const [first, ...rest] = lines;
    const text = [this.theme.bold(first ?? ""), ...rest.map((l) => this.theme.fg("dim", l))];
    this.add(new Text(text.join("\n")));
  }

  addUser(message: Pick<UserMessage, "content" | "origin">): void {
    const text = contentText(message.content).replace(/\s+$/, "");
    const origin = message.origin;
    const label =
      origin === undefined || origin === "user"
        ? this.theme.fg("user", "› ")
        : this.theme.fg("dim", `↳ ${origin}  `);
    this.add(new Text(label + text));
  }

  startAssistant(message: AssistantMessage): AssistantView {
    const view = new AssistantView(this.options);
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
    const color = level === "error" ? "error" : level === "warn" ? "warning" : "dim";
    const mark = level === "error" ? "✗ " : level === "warn" ? "! " : "";
    this.add(new Text(this.theme.fg(color, mark + message)));
  }

  addHookBlocked(reason: string): void {
    this.add(new Text(this.theme.fg("warning", `⛔ Hook 阻止：${reason}`)));
  }

  addRetry(attempt: number, maxAttempts: number, delayMs: number, error: string): void {
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    this.add(
      new Text(
        this.theme.fg("warning", `↻ 重试 ${attempt}/${maxAttempts}（${seconds}s 后）：${error}`),
      ),
    );
  }

  addRetryFailed(error: string | undefined): void {
    this.addNotice("error", `重试失败${error !== undefined ? `：${error}` : ""}`);
  }

  /** 压缩 / 分支摘要卡：token 变化（有则显示）+ 摘要前 3 行。 */
  addSummaryCard(
    summary: string,
    options: { title?: string; tokensBefore?: number; tokensAfter?: number } = {},
  ): void {
    const dim = (s: string): string => this.theme.fg("dim", s);
    const lines = summary
      .trim()
      .split("\n")
      .filter((l) => l.trim() !== "");
    const head = lines.slice(0, 3);
    const body: string[] = [];
    if (options.tokensBefore !== undefined) {
      const after = options.tokensAfter !== undefined ? ` → ${options.tokensAfter}` : "";
      body.push(dim(`${options.tokensBefore}${after} token`));
    }
    body.push(...head.map(dim));
    if (lines.length > head.length) body.push(dim(`…（另 ${lines.length - head.length} 行）`));
    this.add(
      new Box(new Text(body.join("\n")), {
        title: options.title ?? "上下文已压缩",
        theme: this.theme,
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
          const view = new AssistantView(this.options);
          view.finish(message);
          if (!view.isEmpty) this.add(view);
          for (const block of message.content) {
            if (block.type !== "toolCall") continue;
            const tool = hooks.tool(block, results.get(block.id));
            if (tool !== undefined) this.add(tool);
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
