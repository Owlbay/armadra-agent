/**
 * 运行指示与排队消息（终端界面视觉设计 v1 §3.7、§3.8）：输入框上方的 Loader 动词状态机与排队列表。
 *
 * 动词按「当前最深状态」取，避免事件乱序时闪回：
 *   审批打开 → `等待确认`（无 Esc 提示，Esc 由对话框消费）
 *   有运行中的工具 → `运行 bash` / `运行 3 个工具`
 *   自动重试等待中 → `重试 2/3 · 2s 后`（不显示已用时）
 *   压缩中 → `压缩上下文`
 *   助手在流式输出 → 末块是思考 `思考中`，否则 `回复中 · ↓≈1.2k`（本条输出的估算 token，4 字符 ≈ 1）
 *   其余（等首个 token）→ `思考中`
 * 运行或压缩时 Loader 才挂进槽位；附加项 `Esc 中断`。
 *
 * 排队消息：缩进 2 列（挂在当前回合下），`↳ 插话 / 之后  文本` 整体 muted、标签 dim；超过 3 条首行
 * `… 另 N 条`；末行 `Alt+↑ 取回 · Esc 回填并中断`。
 */

import type { AssistantMessage } from "../../ai/types.js";
import type { SessionEvent } from "../../agent/types.js";
import { Container, Text, type Loader, type Theme } from "../../tui.js";
import { ORIGIN_LABELS } from "./message-view.js";
import { formatTokens } from "./status-bar.js";
import type { ToolTracker } from "./tool-view.js";

export const QUEUE_PREVIEW = 3;

export interface RunIndicatorDeps {
  theme: Theme;
  loader: Loader;
  /** Loader 的挂载槽位（运行时才有子组件）。 */
  slot: Container;
  tools: ToolTracker;
  render(): void;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 助手消息里已流出的文字（思考 + 正文）的估算 token 与末块类型。 */
function streamState(message: AssistantMessage): { tokens: number; thinking: boolean } {
  let chars = 0;
  let last: string | undefined;
  for (const block of message.content) {
    if (block.type === "text") {
      chars += block.text.length;
      if (block.text !== "") last = "text";
    } else if (block.type === "thinking") {
      chars += block.thinking.length;
      if (block.thinking !== "") last = "thinking";
    } else if (block.type === "toolCall") last = "toolCall";
  }
  return { tokens: Math.ceil(chars / 4), thinking: last === "thinking" };
}

export class RunIndicator {
  running = false;
  compacting = false;
  private approval = false;
  private retry: { attempt: number; max: number; delayMs: number } | undefined;
  private stream: { tokens: number; thinking: boolean } | undefined;

  constructor(private readonly deps: RunIndicatorDeps) {}

  get busy(): boolean {
    return this.running || this.compacting;
  }

  setApproval(open: boolean): void {
    this.approval = open;
    this.sync();
  }

  /** 会话切换后清零。 */
  reset(): void {
    this.running = false;
    this.compacting = false;
    this.approval = false;
    this.retry = undefined;
    this.stream = undefined;
    this.sync();
  }

  /** 会话事件 → 状态；返回后已同步 Loader。 */
  onEvent(event: SessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.running = true;
        break;
      case "agent_settled":
        this.running = false;
        this.retry = undefined;
        this.stream = undefined;
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          this.retry = undefined;
          this.stream = streamState(event.message);
        }
        break;
      case "message_update":
        if (event.message.role === "assistant") this.stream = streamState(event.message);
        break;
      case "message_end":
        if (event.message.role === "assistant") this.stream = undefined;
        break;
      case "compaction_start":
        this.compacting = true;
        break;
      case "compaction_end":
        this.compacting = false;
        break;
      case "auto_retry_start":
        this.retry = { attempt: event.attempt, max: event.maxAttempts, delayMs: event.delayMs };
        break;
      case "auto_retry_end":
        this.retry = undefined;
        break;
      case "tool_execution_start":
      case "tool_execution_end":
        break;
      default:
        return;
    }
    this.sync();
  }

  /** 按当前状态换动词，并挂上 / 撤下 Loader。 */
  sync(): void {
    const { loader, slot, render } = this.deps;
    const active = this.busy;
    if (active) this.applyVerb();
    if (active && slot.children.length === 0) {
      slot.addChild(loader);
      loader.start();
    } else if (!active && slot.children.length > 0) {
      loader.stop();
      slot.clear();
    }
    render();
  }

  private applyVerb(): void {
    const { loader, tools } = this.deps;
    const esc = ["Esc 中断"];
    if (this.approval) {
      loader.setVerb("等待确认");
      return;
    }
    const running = tools.running();
    const top = running.filter((view) => !running.some((p) => p.children.includes(view)));
    if (top.length === 1) {
      loader.setVerb(`运行 ${top[0]!.toolName}`, esc);
      return;
    }
    if (top.length > 1) {
      loader.setVerb(`运行 ${top.length} 个工具`, esc);
      return;
    }
    if (this.retry !== undefined) {
      const seconds = Math.max(1, Math.round(this.retry.delayMs / 1000));
      loader.setVerb(`重试 ${this.retry.attempt}/${this.retry.max}`, [`${seconds}s 后`], {
        elapsed: false,
      });
      return;
    }
    if (this.compacting) {
      loader.setVerb("压缩上下文", esc);
      return;
    }
    const stream = this.stream;
    if (stream !== undefined && !stream.thinking && stream.tokens > 0) {
      loader.setVerb("回复中", [`↓≈${formatTokens(stream.tokens)}`, ...esc]);
      return;
    }
    loader.setVerb("思考中", esc);
  }
}

/** 排队消息（插话 / 之后），挂在 Loader 之上。 */
export class QueueView extends Text {
  constructor(private readonly theme: Theme) {
    super("");
  }

  setQueue(steering: readonly string[], followUp: readonly string[]): void {
    const t = this.theme;
    const row = (origin: "steer" | "followUp", text: string): string =>
      `  ${t.fg("dim", `${t.glyphs.queued} ${ORIGIN_LABELS[origin]}`)}  ${t.fg("muted", oneLine(text))}`;
    const rows = [
      ...steering.map((text) => row("steer", text)),
      ...followUp.map((text) => row("followUp", text)),
    ];
    const shown = rows.slice(-QUEUE_PREVIEW);
    if (rows.length > shown.length) {
      shown.unshift("  " + t.fg("dim", `${t.glyphs.ellipsis} 另 ${rows.length - shown.length} 条`));
    }
    if (rows.length > 0) {
      shown.push("    " + t.fg("dim", `Alt+${t.glyphs.arrowUp} 取回 · Esc 回填并中断`));
    }
    this.setText(shown.join("\n"));
  }
}
