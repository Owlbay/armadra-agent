/**
 * 一个回合的结果汇总（各驱动共用）。[W5-E]
 *
 * 驱动把归一化后的 {@link DriverEvent} 交给收集器：它转发给 `onEvent`，同时累计最终文本、
 * 工具摘要（≤ 20 行，§5.2）、触及的文件（edit / delete / move 类工具的 locations，以及带 diff 内容的
 * 工具改动的路径——不论种类，见 {@link TurnCollector.noteDiff}）与用量。
 * 原始事件只在内存里流过，不落盘（§5.4 敏感数据）。
 */

import type { AcpToolKind, DriverEvent, DriverTurnResult } from "./types.js";

export const TOOL_SUMMARY_LINES = 20;

const WRITE_KINDS: ReadonlySet<AcpToolKind> = new Set(["edit", "delete", "move"]);

interface ToolState {
  title: string;
  kind: AcpToolKind;
  status: "pending" | "in_progress" | "completed" | "failed";
  locations: string[];
  /** 工具内容里 diff 的路径（ACP `content[].type === "diff"`）。 */
  diffPaths?: string[];
}

export class TurnCollector {
  private text = "";
  private readonly tools = new Map<string, ToolState>();
  private readonly order: string[] = [];
  private usage: NonNullable<DriverTurnResult["usage"]> = {};

  constructor(private readonly onEvent: (event: DriverEvent) => void) {}

  /** 归一化事件：累计后转发给 onEvent。 */
  push(event: DriverEvent): void {
    switch (event.type) {
      case "message_delta":
        this.text += event.text;
        break;
      case "tool_call": {
        const known = this.tools.get(event.id);
        const next: ToolState = {
          title: event.title !== "" ? event.title : (known?.title ?? event.id),
          kind: event.kind,
          status: event.status,
          locations: event.locations ?? known?.locations ?? [],
          ...(known?.diffPaths !== undefined ? { diffPaths: known.diffPaths } : {}),
        };
        if (known === undefined) this.order.push(event.id);
        this.tools.set(event.id, next);
        break;
      }
      case "usage":
        this.mergeUsage(event);
        break;
      default:
        break;
    }
    this.onEvent(event);
  }

  /**
   * 记下工具改动的文件（diff 内容的路径）：工具完成后计入 filesTouched，不论它报的种类。
   * 在 `push` 该工具的 `tool_call` 之后调（未知的 id 忽略）。[ACP-D]
   */
  noteDiff(id: string, paths: readonly string[]): void {
    const known = this.tools.get(id);
    if (known === undefined || paths.length === 0) return;
    known.diffPaths = [...new Set([...(known.diffPaths ?? []), ...paths])];
  }

  /** 工具调用的最近状态（驱动做 tool_call_update 时补全标题与种类）。 */
  tool(id: string): Readonly<ToolState> | undefined {
    return this.tools.get(id);
  }

  /** 回合结束时的累计用量合并（`result.usage` 等）。 */
  mergeUsage(usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    costUsd?: number;
  }): void {
    if (usage.input !== undefined) this.usage.input = usage.input;
    if (usage.output !== undefined) this.usage.output = usage.output;
    if (usage.cacheRead !== undefined) this.usage.cacheRead = usage.cacheRead;
    if (usage.costUsd !== undefined) this.usage.costUsd = usage.costUsd;
  }

  get finalText(): string {
    return this.text;
  }

  /** 原生协议以整条消息给出最终文本时覆盖（流式增量与整条只取其一）。 */
  setFinalText(text: string): void {
    this.text = text;
  }

  result(stopReason: DriverTurnResult["stopReason"]): DriverTurnResult {
    const files = new Set<string>();
    for (const tool of this.tools.values()) {
      if (tool.status !== "completed") continue;
      if (WRITE_KINDS.has(tool.kind)) for (const path of tool.locations) files.add(path);
      for (const path of tool.diffPaths ?? []) files.add(path);
    }
    const lines = this.order.map((id) => {
      const tool = this.tools.get(id) as ToolState;
      return `${tool.status === "failed" ? "✗" : tool.status === "completed" ? "✓" : "…"} ${tool.kind} ${tool.title}`;
    });
    const summary =
      lines.length > TOOL_SUMMARY_LINES
        ? [
            ...lines.slice(0, TOOL_SUMMARY_LINES - 1),
            `… ${lines.length - TOOL_SUMMARY_LINES + 1} more tool calls`,
          ]
        : lines;
    const result: DriverTurnResult = {
      stopReason,
      finalText: this.text,
      filesTouched: [...files],
      toolSummary: summary,
    };
    if (Object.keys(this.usage).length > 0) result.usage = { ...this.usage };
    return result;
  }
}

/** 单行、截断（标题与摘要用）。 */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
