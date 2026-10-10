/**
 * 前台子 Agent 任务转后台与栏内停止的界面接线（docs/history/agents-concurrency-plan.md §2.4、§2.8）。[W7-C]
 *
 * - `Ctrl+B`（`app.tasks.background`）：有阻塞中的前台任务（`registry.blocking()`，含 `task_ctl wait`）时
 *   全部转后台（`session.backgroundTask(undefined, "user")`），不看输入框；没有时落回编辑器。
 * - 栏内 `b` / `Ctrl+B`：转后台选中的任务；`x`：1.5 s 内连按两次停止（`StopArm`）。
 * - `/tasks bg [id]`（commands-core.ts，line 模式同）：同 Ctrl+B / 指定任务。
 * - Esc 中断只连带前台任务：仍在运行的后台任务写进中断提示（`runningBackground`）。
 */

import { registryOf } from "../../agent/subagent-registry.js";
import type { AgentSession } from "../../agent/types.js";
import { msg } from "../../i18n/index.js";
import type { ActionId, Keybindings } from "../../tui.js";

/** 栏内 `x` 两次之间的最长间隔。 */
export const STOP_CONFIRM_MS = 1500;

/** 正在阻塞父回合的任务（前台运行中、或有 `task_ctl wait` 在等）。 */
export function blockingTasks(session: AgentSession): string[] {
  return registryOf(session.state.sessionId)?.blocking() ?? [];
}

/** 人工转后台：不给 taskId = 全部阻塞中的任务（没有时不调用，返回空）。 */
export function backgroundTasks(session: AgentSession, taskId?: string): string[] {
  if (taskId === undefined && blockingTasks(session).length === 0) return [];
  return session.backgroundTask(taskId, "user");
}

/** 仍在运行的后台任务（Esc 中断不影响它们）。 */
export function runningBackground(session: AgentSession): string[] {
  const registry = registryOf(session.state.sessionId);
  if (registry === undefined) return [];
  return registry
    .list()
    .filter((task) => task.status === "running" && task.background)
    .map((task) => task.taskId);
}

/** 转后台后的一行提示；没有转任何任务时给「没有可转的」。 */
export function backgroundedText(ids: readonly string[]): string {
  const m = msg().agents.background;
  return ids.length === 0 ? m.none : m.done(ids.join(", "));
}

/** `ctrl+b` → `Ctrl+B`（提示行用）；动作没有绑定时 undefined。 */
export function keyLabel(keys: Keybindings, action: ActionId): string | undefined {
  const id = keys.keys(action)[0];
  if (id === undefined) return undefined;
  return id
    .split("+")
    .map((part) =>
      part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1),
    )
    .join("+");
}

/** 栏内 `x` 的双击确认：第一次 `arm`（提示「再按 x 停止」），间隔内对同一任务再按为 `stop`。 */
export class StopArm {
  private armed: { taskId: string; at: number } | undefined;

  constructor(private readonly windowMs = STOP_CONFIRM_MS) {}

  press(taskId: string, now: number): "arm" | "stop" {
    const armed = this.armed;
    if (armed !== undefined && armed.taskId === taskId && now - armed.at < this.windowMs) {
      this.armed = undefined;
      return "stop";
    }
    this.armed = { taskId, at: now };
    return "arm";
  }

  reset(): void {
    this.armed = undefined;
  }
}
