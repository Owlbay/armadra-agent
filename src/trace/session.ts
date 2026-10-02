/**
 * 轨迹与运行中会话之间的胶水（TUI `/trace`、line 模式 `/trace`；W6-T2 的 RPC / SDK 可复用）。[W6-T1]
 *
 * - `traceInputOf(session)`：会话 → `TraceInput`（头、全部条目、当前叶子、会话文件）。
 * - `childLoader()`：读 ama 子会话文件（只读、不加锁），按 mtime + 大小缓存；读不到返回 undefined
 *   （构建器据此标 `childMissing`）。
 * - `LiveTracker`：订阅会话事件，给出 `LiveOverlay`（在途请求、执行中的工具、是否运行中）。
 * - `traceText(session, taskId?)`：line 模式的整表文本。
 */

import { statSync } from "node:fs";
import { AgentSessionImpl } from "../agent/session.js";
import type { AgentSession, SessionEvent } from "../agent/types.js";
import { msg } from "../i18n/index.js";
import type { CommandHandler } from "../modes/commands-core.js";
import { readSessionReadOnly } from "../session/scan.js";
import type { SessionHeader } from "../session/types.js";
import { plainTheme } from "../tui/theme.js";
import {
  buildTrace,
  findSubagent,
  loadSubagentTrace,
  type LiveOverlay,
  type LiveTool,
  type TraceInput,
} from "./build.js";
import { describeNode, entryLookup } from "./detail.js";
import { flattenNode } from "./flatten.js";
import { expandAll, formatTraceText, summaryText } from "./format.js";
import type { Trace } from "./types.js";

/** 会话 → 构建器输入。非 `AgentSessionImpl`（测试替身）用 state 拼一个头，叶子取最后一条。 */
export function traceInputOf(session: AgentSession): TraceInput {
  if (session instanceof AgentSessionImpl) {
    const manager = session.manager;
    const file = manager.file();
    return {
      header: manager.header(),
      entries: manager.entries(),
      leaf: manager.leafId(),
      ...(file !== undefined ? { sessionFile: file } : {}),
    };
  }
  const entries = session.entries;
  const header: SessionHeader = {
    type: "session",
    version: 1,
    id: session.state.sessionId,
    timestamp: entries[0]?.timestamp ?? new Date(0).toISOString(),
    cwd: session.state.cwd,
    agent: { name: "ama", version: "" },
  };
  const file = session.state.sessionFile;
  return { header, entries, ...(file !== undefined ? { sessionFile: file } : {}) };
}

/** 只读读取一个会话文件为构建器输入；读不到或损坏返回 undefined。 */
export function readTraceInput(file: string): TraceInput | undefined {
  try {
    const read = readSessionReadOnly(file);
    return { header: read.header, entries: read.entries, leaf: read.leaf, sessionFile: file };
  } catch {
    return undefined;
  }
}

export type ChildLoader = ((file: string) => TraceInput | undefined) & {
  /** 已读过的子会话（详情预览取正文用）。 */
  inputs(): TraceInput[];
};

/** 带缓存的子会话读取（文件没变就不重读）。 */
export function childLoader(read: (file: string) => TraceInput | undefined = readTraceInput) {
  const cache = new Map<string, { stamp: string; input: TraceInput | undefined }>();
  const load = ((file: string) => {
    let stamp = "";
    try {
      const st = statSync(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = "missing";
    }
    const hit = cache.get(file);
    if (hit !== undefined && hit.stamp === stamp) return hit.input;
    const input = stamp === "missing" ? undefined : read(file);
    cache.set(file, { stamp, input });
    return input;
  }) as ChildLoader;
  load.inputs = () => [...cache.values()].flatMap((v) => (v.input === undefined ? [] : [v.input]));
  return load;
}

/** 订阅会话事件，维护 live 叠加层。 */
export class LiveTracker {
  private request: LiveOverlay["request"];
  private readonly tools = new Map<string, LiveTool>();

  constructor(
    private readonly session: () => AgentSession,
    private readonly now: () => number = Date.now,
  ) {}

  /** 处理一个事件；返回它是否影响轨迹（调用方据此安排刷新）。 */
  onEvent(event: SessionEvent): boolean {
    switch (event.type) {
      case "message_start":
        if (event.message.role !== "assistant") return false;
        this.request = { requestAt: event.message.timestamp };
        return true;
      case "message_update":
        if (this.request === undefined || this.request.firstTokenAt !== undefined) return false;
        this.request.firstTokenAt = this.now();
        this.request.provider = event.message.provider;
        this.request.model = event.message.model;
        return true;
      case "message_end":
        if (event.message.role !== "assistant") return false;
        this.request = undefined;
        return true;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          startedAt: this.now(),
          ...(event.parentToolCallId !== undefined ? { parentId: event.parentToolCallId } : {}),
        });
        return true;
      case "tool_execution_end":
        this.tools.delete(event.toolCallId);
        return true;
      case "agent_end":
        this.request = undefined;
        this.tools.clear();
        return true;
      case "entry_appended":
      case "telemetry_tick":
      case "agent_start":
        return true;
      default:
        return false;
    }
  }

  overlay(): LiveOverlay {
    const live: LiveOverlay = { running: this.session().state.isStreaming };
    if (this.request !== undefined) live.request = { ...this.request };
    if (this.tools.size > 0) live.tools = [...this.tools.values()];
    return live;
  }
}

/** 任务的根节点（ama 子会话就地加载子轨迹）。 */
export function taskRoot(trace: Trace, taskId: string, loadChild: ChildLoader) {
  const node = findSubagent(trace, taskId);
  if (node !== undefined) loadSubagentTrace(node, loadChild);
  return node;
}

/** line 模式 `/trace [任务 id]` 的文本。 */
export function traceText(session: AgentSession, taskId?: string): string {
  const input = traceInputOf(session);
  const loadChild = childLoader();
  const trace = buildTrace(input, { loadChild });
  const lookup = entryLookup(
    [...input.entries, ...loadChild.inputs().flatMap((i) => i.entries)],
    input.header.cwd,
  );
  const ctx = {
    theme: plainTheme(),
    describe: (n: Parameters<typeof describeNode>[0]) => describeNode(n, lookup),
  };
  if (taskId === undefined) return formatTraceText(trace, ctx);
  const node = taskRoot(trace, taskId, loadChild);
  if (node === undefined) return `${msg().trace.taskNotFound(taskId)}\n`;
  const rows = expandAll((expanded) => flattenNode(node, { expanded }));
  // 标题换成任务；汇总用子轨迹（外部任务没有子轨迹，只有标题与骨架行）
  const summary = node.child !== undefined ? ` · ${summaryText(node.child, ctx.theme)}` : "";
  return formatTraceText(
    trace,
    ctx,
    rows,
    `${msg().trace.taskTitle(node.taskId, node.agent)}${summary}`,
  );
}

/** line 模式 `CommandContext.extra.trace`。 */
export const lineTraceCommand: CommandHandler = async (args, ctx) => {
  const taskId = args.trim() === "" ? undefined : args.trim();
  return { kind: "handled", message: traceText(ctx.session(), taskId).replace(/\n$/, "") };
};
