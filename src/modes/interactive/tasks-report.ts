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
import { formatTokenCount, formatUsd } from "../session-report.js";
import { formatDuration } from "./tool-summary.js";

const STATUS: Readonly<Record<SubagentStatus | "running", string>> = {
  running: "运行中",
  completed: "完成",
  failed: "失败",
  aborted: "已停止",
  max_turns: "轮数耗尽",
  interrupted: "已中断",
};

export function taskStatusText(status: SubagentStatus | "running"): string {
  return STATUS[status];
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
  if (task.turns !== undefined && task.turns > 0) facts.push(`${task.turns} 轮`);
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
  const agent =
    task.runner !== "ama" && task.runner !== task.agent
      ? `${task.agent}（${task.runner}）`
      : task.agent;
  const parts = [agent, ...taskFacts(task, now)];
  if (task.background) parts.push("后台");
  const description = oneLine(task.description);
  return `${task.taskId}  ${parts.join(" · ")}${description !== "" ? `  ${description}` : ""}`;
}

/** `/tasks` 的纯文本（line 模式）。 */
export function describeTasks(sessionId: string, now: number): string {
  const tasks = listTasks(sessionId);
  if (tasks.length === 0) return "还没有子 Agent 任务";
  return [
    `子 Agent 任务（${tasks.length}）：`,
    ...tasks.map((task) => `  ${taskLine(task, now)}`),
    "/tasks <id> 查看输出 · /tasks stop <id> 停止",
  ].join("\n");
}

/** 一个任务的输出全文（line 模式 `/tasks <id>`）。 */
export function describeTaskOutput(sessionId: string, taskId: string, now: number): string {
  const task = taskRegistryView(sessionId)?.get(taskId);
  if (task === undefined) return `没有任务 ${taskId}`;
  const output = taskOutput(sessionId, taskId) ?? "";
  const file = task.outputFile !== undefined ? `\n全文：${task.outputFile}` : "";
  return `${taskLine(task, now)}${file}\n${output.trim() === "" ? "（还没有输出）" : output.trimEnd()}`;
}

const SOURCE: Readonly<Record<string, string>> = {
  builtin: "内置",
  cli: "命令行",
  profile: "profile",
  user: "用户",
  project: "项目",
  host: "宿主",
};

/** 类型一行的状态：外部 Agent 写安装与版本。 */
export function agentFacts(agent: AgentInfo): string[] {
  const facts = [agent.runner, SOURCE[agent.source] ?? agent.source];
  if (agent.installed === false) facts.push("未安装");
  else if (agent.installed === true)
    facts.push(agent.version !== undefined ? `已安装 ${agent.version}` : "已安装");
  return facts;
}

/** `/agents` 的纯文本（line 模式）。 */
export function describeAgents(sessionId: string): string {
  const agents = listAgents(sessionId);
  if (agents.length === 0) return "当前会话没有子 Agent（task 工具未启用）";
  const width = Math.max(...agents.map((a) => a.name.length));
  return [
    `子 Agent 类型（${agents.length}）：`,
    ...agents.map(
      (a) => `  ${a.name.padEnd(width)}  ${agentFacts(a).join(" · ")}  ${oneLine(a.description)}`,
    ),
  ].join("\n");
}
