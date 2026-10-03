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
 * [W7-A] 有该显示的子 Agent 任务时再带可丢弃的 `↓ Agent 栏`（窄屏先丢它）；任务随时出现 / 结束，
 * 每帧对一次，变了才换动词。
 * [W7-C] 有阻塞中的前台任务时可丢弃项前面加 `Ctrl+B 转后台`；有停靠的审批时 `↓ Agent 栏` 换成
 * `↓ 处理审批`。顺序 `Esc 中断 · Ctrl+B 转后台 · ↓ Agent 栏`，窄屏从后往前丢。
 *
 * 排队消息：缩进 2 列（挂在当前回合下），`↳ 插话 / 之后  文本` 整体 muted、标签 dim；超过 3 条首行
 * `… 另 N 条`；末行 `Alt+↑ 取回 · Esc 回填并中断`。
 */

import { msg } from "../../i18n/index.js";
import type { AssistantMessage } from "../../ai/types.js";
import type { SessionEvent } from "../../agent/types.js";
import { Container, Text, type Loader, type Theme } from "../../tui.js";
import { originLabel } from "./message-view.js";
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
  /** [W7-C] `app.tasks.background` 的按键标签（`Ctrl+B`）；没有绑定时不提示。 */
  backgroundKey?: string;
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
  /** [W7-A] 有该显示的子 Agent 任务（interactive-mode 在 AgentUi 建好后接上）。 */
  agents: () => boolean = () => false;
  /** [W7-C] 有阻塞中的前台任务（Ctrl+B 可转后台）。 */
  background: () => boolean = () => false;
  /** [W7-C] 有停靠在 Agent 栏的审批。 */
  docked: () => boolean = () => false;
  private hintKey = "";

  constructor(private readonly deps: RunIndicatorDeps) {
    deps.loader.onFrame(() => {
      if (this.busy && !this.approval && this.optionalHints().join("\n") !== this.hintKey)
        this.applyVerb();
    });
  }

  /** 可丢弃的按键提示（按丢弃的逆序排列）。 */
  private optionalHints(): string[] {
    const down = this.deps.theme.glyphs.arrowDown;
    const key = this.deps.backgroundKey;
    const out: string[] = [];
    if (key !== undefined && this.background()) out.push(msg().agents.background.runHint(key));
    if (this.docked()) out.push(msg().agents.approval.runHint(down));
    else if (this.agents()) out.push(msg().agents.bar.runHint(down));
    return out;
  }

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
    const m = msg().interactive.view.run;
    const esc = [m.esc];
    if (this.approval) {
      this.hintKey = "";
      loader.setVerb(m.awaitingApproval);
      return;
    }
    const hints = this.optionalHints();
    this.hintKey = hints.join("\n");
    const optional = hints.length > 0 ? { optional: hints } : {};
    const running = tools.running();
    const top = running.filter((view) => !running.some((p) => p.children.includes(view)));
    if (top.length === 1) {
      loader.setVerb(m.runningTool(top[0]!.toolName), esc, optional);
      return;
    }
    if (top.length > 1) {
      loader.setVerb(m.runningTools(top.length), esc, optional);
      return;
    }
    if (this.retry !== undefined) {
      const seconds = Math.max(1, Math.round(this.retry.delayMs / 1000));
      loader.setVerb(m.retry(this.retry.attempt, this.retry.max), [m.retryIn(seconds)], {
        elapsed: false,
      });
      return;
    }
    if (this.compacting) {
      loader.setVerb(m.compacting, esc, optional);
      return;
    }
    const stream = this.stream;
    if (stream !== undefined && !stream.thinking && stream.tokens > 0) {
      loader.setVerb(m.replying, [`↓≈${formatTokens(stream.tokens)}`, ...esc], optional);
      return;
    }
    loader.setVerb(m.thinking, esc, optional);
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
      `  ${t.fg("dim", `${t.glyphs.queued} ${originLabel(origin)}`)}  ${t.fg("muted", oneLine(text))}`;
    const rows = [
      ...steering.map((text) => row("steer", text)),
      ...followUp.map((text) => row("followUp", text)),
    ];
    const shown = rows.slice(-QUEUE_PREVIEW);
    if (rows.length > shown.length) {
      shown.unshift(
        "  " +
          t.fg(
            "dim",
            msg().interactive.view.run.queueMore(t.glyphs.ellipsis, rows.length - shown.length),
          ),
      );
    }
    if (rows.length > 0) {
      shown.push("    " + t.fg("dim", msg().interactive.view.run.queueHint(t.glyphs.arrowUp)));
    }
    this.setText(shown.join("\n"));
  }
}
