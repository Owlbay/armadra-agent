/**
 * 子 Agent 视图的正文（docs/wave6-plan.md §1.2、D2）。[W6-A]
 *
 * - `AmaTranscript`：ama 子会话的全量消息，复用消息区的 `MessageView` / `ToolTracker` 渲染；先按条目重放
 *   （句柄在内存时读 `entries()`，被 LRU 释放或 resume 后只读加载子会话文件），运行中再跟随子会话事件。
 *   视图里直接发的消息（`origin:"direct"`）按普通用户消息显示——在这里就是人发给它的。
 * - `ExternalTranscript`：外部 Agent 的内存环形缓冲（文本、思考、工具起止、回合、notice）；重启后缓冲为空，
 *   只给一行「用原 CLI resume」的说明。
 */

import type { SessionEvent } from "../../agent/types.js";
import type { ExternalDisplayEvent } from "../../agents/task-record.js";
import type { AgentMessage } from "../../session/types.js";
import type { SessionEntry } from "../../session/types.js";
import { entryToMessage } from "../../session/projection.js";
import { readSessionReadOnly } from "../../session/scan.js";
import { indexEntries, pathToRoot } from "../../session/tree.js";
import { wrapTextWithAnsi, type Component, type Theme } from "../../tui.js";
import { msg } from "../../i18n/index.js";
import { MessageView, type MessageViewOptions } from "./message-view.js";
import { ToolTracker } from "./tool-view.js";

/** 视图里人发的消息按普通用户消息显示。 */
function shown<T extends AgentMessage>(message: T): T {
  if (message.role === "user" && message.origin === "direct") {
    const { origin: _direct, ...rest } = message;
    return rest as T;
  }
  return message;
}

/** 只读读子会话文件当前分支的条目。 */
export function readBranch(file: string): SessionEntry[] {
  const session = readSessionReadOnly(file);
  return pathToRoot(indexEntries(session.entries), session.leaf);
}

export class AmaTranscript implements Component {
  private readonly view: MessageView;
  private readonly tools: ToolTracker;

  constructor(private readonly options: MessageViewOptions & { now(): number; cwd?: string }) {
    this.view = new MessageView(options);
    this.tools = new ToolTracker({
      theme: options.theme,
      now: options.now,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  }

  get isEmpty(): boolean {
    return this.view.blockCount === 0;
  }

  /** 按条目重画（打开视图、重新接上句柄）。 */
  load(entries: readonly SessionEntry[]): void {
    this.view.reset();
    this.tools.clear();
    const messages: AgentMessage[] = [];
    for (const entry of entries) {
      const message = entryToMessage(entry);
      if (message !== undefined) messages.push(shown(message));
    }
    this.view.replay(messages, {
      tool: (call, result) => {
        if (result === undefined)
          return this.tools.start({
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments,
          }).view;
        return this.tools.completed(
          call.id,
          call.name,
          call.arguments,
          {
            content: result.content,
            isError: result.isError,
            ...(result.details !== undefined ? { details: result.details } : {}),
          },
          result.isError,
        );
      },
    });
  }

  /** 子会话事件；返回 true 表示内容变了。 */
  onEvent(event: SessionEvent): boolean {
    switch (event.type) {
      case "message_start": {
        const message = event.message;
        if (message.role === "user") this.view.addUser(shown(message));
        else if (message.role === "assistant") this.view.startAssistant(message);
        else return false;
        return true;
      }
      case "message_update":
        this.view.updateAssistant(event.message);
        return true;
      case "message_end":
        if (event.message.role !== "assistant") return false;
        this.view.endAssistant(event.message);
        return true;
      case "tool_execution_start": {
        const started = this.tools.start(event);
        if (started.topLevel) this.view.addTool(started.view);
        return true;
      }
      case "tool_execution_update":
        this.tools.update(event.toolCallId, event.partial);
        return true;
      case "tool_execution_end":
        this.tools.end(event.toolCallId, event.result, event.isError);
        return true;
      default:
        return false;
    }
  }

  tick(): void {
    this.tools.tick();
  }

  render(width: number): string[] {
    return this.view.render(width);
  }

  invalidate(): void {
    this.view.invalidate();
  }
}

export interface ExternalSource {
  events(): readonly ExternalDisplayEvent[];
  running(): boolean;
  runner: string;
  sessionId?: string;
}

export class ExternalTranscript implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly source: ExternalSource,
  ) {}

  get isEmpty(): boolean {
    return this.source.events().length === 0;
  }

  render(width: number): string[] {
    const t = this.theme;
    const g = t.glyphs;
    const m = msg().agents.view;
    const events = this.source.events();
    if (events.length === 0) {
      const text = this.source.running()
        ? m.waiting
        : this.source.sessionId !== undefined
          ? m.externalGone(this.source.runner, this.source.sessionId)
          : m.externalNoSession(this.source.runner);
      return wrapTextWithAnsi(t.fg("dim", text), width);
    }
    // 工具：started 与随后同 id 的结束合成一行
    const ended = new Map<string, "completed" | "failed">();
    for (const e of events)
      if (e.kind === "tool" && e.toolId !== undefined && e.status !== "started")
        ended.set(e.toolId, e.status as "completed" | "failed");
    const out: string[] = [];
    let last: ExternalDisplayEvent["kind"] | undefined;
    const block = (lines: string[]): void => {
      if (out.length > 0) out.push("");
      out.push(...lines);
    };
    for (const e of events) {
      if (e.kind === "tool" && e.status !== "started" && e.toolId !== undefined) continue;
      switch (e.kind) {
        case "text":
          block(wrapTextWithAnsi((e.text ?? "").trim(), width));
          break;
        case "thought":
          block(wrapTextWithAnsi(t.fg("dim", `${g.thinking} ${(e.text ?? "").trim()}`), width));
          break;
        case "tool": {
          const status = e.toolId !== undefined ? ended.get(e.toolId) : e.status;
          const mark =
            status === "completed"
              ? t.fg("success", g.ok)
              : status === "failed"
                ? t.fg("error", g.fail)
                : t.fg("dim", g.spinnerStatic);
          const line = `${t.fg("tool", g.tool)} ${e.toolName ?? ""} ${mark}`;
          // 相邻的工具行不空行
          if (last === "tool") out.push(line);
          else block([line]);
          break;
        }
        case "turn":
          block([t.fg("dim", `${g.rule.repeat(2)} ${m.turn(e.turn ?? 0)}`)]);
          break;
        case "notice":
          block(
            wrapTextWithAnsi(t.fg(e.level === "warn" ? "warning" : "dim", e.text ?? ""), width),
          );
          break;
      }
      last = e.kind;
    }
    return out;
  }

  invalidate(): void {}
}
