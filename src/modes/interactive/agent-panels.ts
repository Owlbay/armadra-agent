/**
 * 第五波的消息区面板（左竖条卡片，与 `/session` 同一手法）：`/plan`、`/agents`、`/tasks` 展开的任务输出。
 * [W5-U] line 模式用 plan-command.ts / tasks-report.ts 的文本版。
 */

import type { AgentSession, PlanData } from "../../agent/types.js";
import { permissionModeLabel } from "../../permissions/modes.js";
import type { PlanController } from "../../plan/controller.js";
import { executionMode } from "../../plan/store.js";
import type { TaskInfo } from "../../tools/types.js";
import { Card, wrapTextWithAnsi, type Component, type KeyValueRow, type Theme } from "../../tui.js";
import { Indent, Stack, keyValue } from "./panels.js";
import { planStatusText, planTitle } from "./plan-command.js";
import { agentFactItems, listAgents, taskFacts } from "./tasks-report.js";
import { cleanLines } from "./tool-summary.js";

/** 折行显示的若干行。 */
class Lines implements Component {
  constructor(private readonly lines: readonly string[]) {}

  render(width: number): string[] {
    return this.lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
  }

  invalidate(): void {}
}

const STATUS_COLOR: Readonly<Record<PlanData["status"], "warning" | "success" | "dim">> = {
  proposed: "warning",
  approved: "success",
  rejected: "dim",
  superseded: "dim",
};

/** `/plan`：当前计划、状态、模式、步骤与待办进度。 */
export function planPanel(
  controller: PlanController,
  session: AgentSession,
  theme: Theme,
  displayPath: (path: string) => string = (p) => p,
): Component {
  const plan = controller.current();
  const mode = session.state.permissionMode;
  const modeText =
    mode === "plan"
      ? `Plan${theme.fg("dim", `（批准后回到 ${permissionModeLabel(executionMode(undefined, controller.prePlanMode()))}）`)}`
      : permissionModeLabel(mode);
  if (plan === null) {
    const hint =
      mode === "plan"
        ? "还没有计划：模型给出 <proposed_plan> 后在这里审批"
        : "没有计划。/plan <目标> 进入 Plan 模式";
    return new Card(new Lines([theme.fg("muted", hint)]), { theme, title: "计划" });
  }
  const rows: KeyValueRow[] = [
    { key: "状态", value: theme.fg(STATUS_COLOR[plan.status], planStatusText(plan.status)) },
    { key: "模式", value: modeText },
  ];
  const todos = controller.todos();
  if (todos.length > 0) {
    const done = todos.filter((t) => t.status === "done").length;
    const current = todos.find((t) => t.status === "in_progress");
    rows.push({
      key: "待办",
      value: `${done}/${todos.length} 完成${current !== undefined ? theme.fg("dim", ` · 进行中 ${current.text}`) : ""}`,
    });
  }
  const parts: (Component | string)[] = [theme.bold(planTitle(plan)), keyValue(rows, theme)];
  if (plan.steps.length > 0) {
    parts.push(theme.bold(`步骤（${plan.steps.length}）`));
    parts.push(
      new Indent(new Lines(plan.steps.map((s) => `${theme.fg("dim", s.id)} ${s.text}`)), 2),
    );
  }
  if (plan.status === "proposed")
    parts.push(
      new Lines([
        theme.fg("dim", "/plan approve [模式|fresh] 批准 · /plan reject 放弃 · 直接输入修改意见"),
      ]),
    );
  return new Card(new Stack(parts), {
    theme,
    title: `计划 v${plan.version}`,
    ...(plan.filePath !== undefined ? { subtitle: displayPath(plan.filePath) } : {}),
  });
}

/** `/agents`：类型、runner、来源、安装状态与版本、说明。 */
export function agentsPanel(sessionId: string, theme: Theme): Component {
  const agents = listAgents(sessionId);
  if (agents.length === 0)
    return new Card(new Lines([theme.fg("muted", "当前会话没有子 Agent（task 工具未启用）")]), {
      theme,
      title: "子 Agent",
    });
  const rows: KeyValueRow[] = agents.map((agent) => {
    const status = agentFactItems(agent).map((f) =>
      f.state === "missing"
        ? theme.fg("warning", f.text)
        : f.state === "installed"
          ? theme.fg("success", f.text)
          : f.text,
    );
    return {
      key: agent.name,
      value: `${status.join(theme.fg("dim", " · "))}  ${theme.fg("muted", agent.description.replace(/\s+/g, " "))}`,
    };
  });
  return new Card(keyValue(rows, theme, true), { theme, title: `子 Agent（${agents.length}）` });
}

/** `/tasks` 选中一个任务：状态行 + 输出全文（运行中为已有输出）。 */
export function taskOutputPanel(
  task: TaskInfo,
  output: string | undefined,
  theme: Theme,
  now: number,
  displayPath: (path: string) => string = (p) => p,
): Component {
  const body = output === undefined || output.trim() === "" ? [] : cleanLines(output.trimEnd());
  const lines = [
    ...(task.description.trim() !== "" ? [theme.fg("muted", task.description.trim())] : []),
    ...(body.length === 0 ? [theme.fg("dim", "（还没有输出）")] : body),
  ];
  if (task.outputFile !== undefined)
    lines.push(theme.fg("dim", `全文：${displayPath(task.outputFile)}`));
  const facts = [task.agent, ...taskFacts(task, now), ...(task.background ? ["后台"] : [])];
  return new Card(new Lines(lines), {
    theme,
    title: `任务 ${task.taskId}`,
    subtitle: facts.join(" · "),
  });
}
