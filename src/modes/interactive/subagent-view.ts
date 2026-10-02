/**
 * 消息区的子 Agent 折叠视图（docs/wave5-plan.md §7.5）。[W5-U]
 *
 * 消费 `subagent_start / update / end`，按 taskId 记下类型、状态、轮数、最近 3 个工具与用量；task 工具行
 * （tool-view.ts）据 `parentToolCallId` 取来显示一行：
 *
 * ```
 * ⏺ task 检查 src/tui 的测试覆盖缺口
 *   ⎿ ⠋ explore · 运行中 1m05s · 3 轮 · read grep bash · ↑12k ↓3.4k
 * ```
 *
 * 后台任务的工具调用立即返回，工具行下面多一行跟随状态（`↳ t2 explore · 完成 · 7 轮 …`，运行中每秒刷新）；
 * 完成后父会话收到的 `<task-notification>` 只显示一行（`notificationSummary`），失败 / 停止另有一行提示。
 * 外部 runner（claude / codex）同一组事件，用量可能缺。
 */

import type { SessionEvent, SubagentStatus } from "../../agent/types.js";
import type { Usage } from "../../ai/types.js";
import { formatElapsed, type Theme } from "../../tui.js";
import { formatTokenCount } from "../session-report.js";
import { taskStatusText } from "./tasks-report.js";

export const RECENT_TOOLS = 3;

export interface SubagentState {
  taskId: string;
  parentToolCallId: string;
  agent: string;
  runner: string;
  background: boolean;
  status: SubagentStatus | "running";
  turns: number;
  /** 最近的工具名（最多 3 个，新的在后）。 */
  tools: string[];
  usage?: Usage;
  startedAt: number;
  endedAt?: number;
}

export class SubagentTracker {
  private readonly tasks = new Map<string, SubagentState>();
  private readonly byCall = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 子 Agent 事件：更新状态并返回它；其它事件返回 undefined。 */
  onEvent(event: SessionEvent): SubagentState | undefined {
    switch (event.type) {
      case "subagent_start": {
        const previous = this.tasks.get(event.taskId);
        const state: SubagentState = {
          taskId: event.taskId,
          parentToolCallId: event.parentToolCallId,
          agent: event.agent,
          runner: event.runner,
          background: event.background,
          status: "running",
          // 续聊（同一 taskId 再次 start）沿用轮数与工具
          turns: previous?.turns ?? 0,
          tools: previous?.tools ?? [],
          startedAt: this.now(),
        };
        this.tasks.set(event.taskId, state);
        this.byCall.set(event.parentToolCallId, event.taskId);
        return state;
      }
      case "subagent_update": {
        const state = this.tasks.get(event.taskId);
        if (state === undefined) return undefined;
        if (event.turn > state.turns) state.turns = event.turn;
        if (event.usage !== undefined) state.usage = event.usage;
        if (event.kind === "tool" && event.toolName !== undefined) {
          state.tools.push(event.toolName);
          if (state.tools.length > RECENT_TOOLS)
            state.tools.splice(0, state.tools.length - RECENT_TOOLS);
        }
        return state;
      }
      case "subagent_end": {
        const state = this.tasks.get(event.taskId);
        if (state === undefined) return undefined;
        state.status = event.status;
        state.endedAt = this.now();
        if (event.usage !== undefined) state.usage = event.usage;
        return state;
      }
      default:
        return undefined;
    }
  }

  /** 运行中的任务。 */
  running(): SubagentState[] {
    return [...this.tasks.values()].filter((state) => state.status === "running");
  }

  get(taskId: string): SubagentState | undefined {
    return this.tasks.get(taskId);
  }

  /** task 工具调用对应的子 Agent（续聊时是同一 taskId）。 */
  forToolCall(toolCallId: string): SubagentState | undefined {
    const taskId = this.byCall.get(toolCallId);
    return taskId === undefined ? undefined : this.tasks.get(taskId);
  }

  clear(): void {
    this.tasks.clear();
    this.byCall.clear();
  }
}

/** `explore · 运行中 1m05s · 3 轮 · read grep bash · ↑12k ↓3.4k`（已着色：类型 tool 色，其余 muted）。 */
export function subagentLine(state: SubagentState, theme: Theme, now: number): string {
  const g = theme.glyphs;
  const end = state.endedAt ?? now;
  const elapsed = formatElapsed(end - state.startedAt);
  const status =
    state.status === "running" ? `运行中 ${elapsed}` : `${taskStatusText(state.status)} ${elapsed}`;
  const facts = [status];
  if (state.turns > 0) facts.push(`${state.turns} 轮`);
  if (state.tools.length > 0) facts.push(state.tools.join(" "));
  const usage = state.usage;
  if (usage !== undefined && usage.input + usage.output + usage.cacheRead > 0) {
    const input = usage.input + usage.cacheRead + usage.cacheWrite;
    facts.push(
      `${g.arrowUp}${formatTokenCount(input)} ${g.arrowDown}${formatTokenCount(usage.output)}`,
    );
  }
  const color =
    state.status === "running" || state.status === "completed"
      ? "muted"
      : state.status === "failed"
        ? "error"
        : "warning";
  const agent =
    state.runner !== "ama" && state.runner !== state.agent
      ? `${state.agent}（${state.runner}）`
      : state.agent;
  return theme.fg("tool", agent) + theme.fg("dim", " · ") + theme.fg(color, facts.join(" · "));
}

/** 后台任务结束的一行提示。 */
export function backgroundEndText(state: SubagentState): string {
  const turns = state.turns > 0 ? ` · ${state.turns} 轮` : "";
  return `后台任务 ${state.taskId}（${state.agent}）${taskStatusText(state.status)}${turns} · /tasks 查看输出`;
}

/**
 * 父会话收到的 `<task-notification …>`（origin `task` 的用户消息）在消息区只显示一行：
 * `t1 explore 完成 · 7 轮 · /tasks 查看输出`；不是通知格式返回 undefined。
 */
export function notificationSummary(text: string): string | undefined {
  const head = /^<task-notification\s+([^>]*)>/.exec(text.trimStart());
  if (head === null) return undefined;
  const attrs = new Map<string, string>();
  for (const m of (head[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)) attrs.set(m[1]!, m[2]!);
  const taskId = attrs.get("taskId") ?? "?";
  const status = attrs.get("status") as SubagentStatus | undefined;
  const parts = [
    `${taskId} ${attrs.get("agent") ?? ""}`.trim() +
      ` ${status !== undefined && status in STATUS_KEYS ? taskStatusText(status) : (status ?? "")}`,
  ];
  const turns = attrs.get("turns");
  if (turns !== undefined) parts.push(`${turns} 轮`);
  parts.push("/tasks 查看输出");
  return parts.join(" · ");
}

const STATUS_KEYS: Readonly<Record<SubagentStatus, true>> = {
  completed: true,
  failed: true,
  aborted: true,
  max_turns: true,
  interrupted: true,
};
