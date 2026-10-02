/**
 * `/tasks`、`/agents` 的数据与文本（line 模式与交互模式共用）。[W5-U]
 *
 * - 任务：`taskRegistryView(sessionId).list()`（子 Agent 注册表，W5-G）；全文 `registryOf(sessionId).output()`；
 *   停止 `registryOf(sessionId).stop()`。
 * - 类型：`cachedAgentInfos(sessionId) ?? sessionAgents(sessionId)`（外部 Agent 带安装状态与版本，W5-EG）。
 */

import { cachedAgentInfos } from "../../agents/external.js";
import type { AgentInfo } from "../../agents/types.js";
import { registryOf, sessionAgents, taskRegistryView } from "../../agent/subagent-registry.js";
import type { SubagentStatus, TaskInfo } from "../../tools/types.js";
import { msg } from "../../i18n/index.js";
import { formatTokenCount, formatUsd } from "../session-report.js";
import { formatDuration } from "./tool-summary.js";

export function taskStatusText(status: SubagentStatus | "running"): string {
  return msg().panels.tasks.status[status];
}

export function listTasks(sessionId: string): readonly TaskInfo[] {
  return taskRegistryView(sessionId)?.list() ?? [];
}

export function listAgents(sessionId: string): AgentInfo[] {
  return cachedAgentInfos(sessionId) ?? sessionAgents(sessionId);
}

/** 运行中是已有输出，结束后是最终文本。 */
export function taskOutput(sessionId: string, taskId: string): string | undefined {
  return registryOf(sessionId)?.output(taskId);
}

export async function stopTask(sessionId: string, taskId: string): Promise<void> {
  const registry = registryOf(sessionId);
  if (registry === undefined) return;
  await registry.stop(taskId);
}

/** 任务一行的各字段（状态、耗时、轮数、用量、费用）。 */
export function taskFacts(task: TaskInfo, now: number): string[] {
  const end = task.endedAt ?? now;
  const facts = [taskStatusText(task.status), formatDuration(end - task.startedAt)];
  if (task.turns !== undefined && task.turns > 0) facts.push(msg().panels.tasks.turns(task.turns));
  const usage = task.usage;
  if (usage !== undefined && usage.input + usage.output + usage.cacheRead > 0)
    facts.push(
      `↑${formatTokenCount(usage.input + usage.cacheRead + usage.cacheWrite)} ↓${formatTokenCount(usage.output)}`,
    );
  if (task.costUsd !== undefined && task.costUsd > 0) facts.push(formatUsd(task.costUsd));
  return facts;
}

function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `t1  explore · 运行中 · 1m05s · 7 轮 · 描述` */
export function taskLine(task: TaskInfo, now: number): string {
  const m = msg().panels.tasks;
  const agent =
    task.runner !== "ama" && task.runner !== task.agent
      ? m.agentRunner(task.agent, task.runner)
      : task.agent;
  const parts = [agent, ...taskFacts(task, now)];
  if (task.background) parts.push(m.background);
  const description = oneLine(task.description);
  return `${task.taskId}  ${parts.join(" · ")}${description !== "" ? `  ${description}` : ""}`;
}

/** `/tasks` 的纯文本（line 模式）。 */
export function describeTasks(sessionId: string, now: number): string {
  const m = msg().panels.tasks;
  const tasks = listTasks(sessionId);
  if (tasks.length === 0) return m.none;
  return [
    m.heading(tasks.length),
    ...tasks.map((task) => `  ${taskLine(task, now)}`),
    m.footer,
  ].join("\n");
}

/** 一个任务的输出全文（line 模式 `/tasks <id>`）。 */
export function describeTaskOutput(sessionId: string, taskId: string, now: number): string {
  const m = msg().panels.tasks;
  const task = taskRegistryView(sessionId)?.get(taskId);
  if (task === undefined) return m.notFound(taskId);
  const output = taskOutput(sessionId, taskId) ?? "";
  const file = task.outputFile !== undefined ? `\n${m.fullOutput(task.outputFile)}` : "";
  return `${taskLine(task, now)}${file}\n${output.trim() === "" ? m.noOutput : output.trimEnd()}`;
}

function sourceText(source: string): string {
  const table: Readonly<Record<string, string>> = msg().panels.agents.source;
  return table[source] ?? source;
}

/** 类型一行的状态：外部 Agent 写安装与版本。 */
export function agentFacts(agent: AgentInfo): string[] {
  return agentFactItems(agent).map((fact) => fact.text);
}

/** [W6-C0] 带状态的事实项：界面按 `state` 上色，不按文案判断（文案会随界面语言变）。 */
export interface AgentFact {
  text: string;
  state?: "missing" | "installed";
}

export function agentFactItems(agent: AgentInfo): AgentFact[] {
  const m = msg().panels.agents;
  const facts: AgentFact[] = [{ text: agent.runner }, { text: sourceText(agent.source) }];
  if (agent.installed === false) facts.push({ text: m.notInstalled, state: "missing" });
  else if (agent.installed === true)
    facts.push({ text: m.installed(agent.version), state: "installed" });
  return facts;
}

/** `/agents` 的纯文本（line 模式）。 */
export function describeAgents(sessionId: string): string {
  const m = msg().panels.agents;
  const agents = listAgents(sessionId);
  if (agents.length === 0) return m.none;
  const width = Math.max(...agents.map((a) => a.name.length));
  return [
    m.typesHeading(agents.length),
    ...agents.map(
      (a) => `  ${a.name.padEnd(width)}  ${agentFacts(a).join(" · ")}  ${oneLine(a.description)}`,
    ),
  ].join("\n");
}
