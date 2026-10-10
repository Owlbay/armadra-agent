/**
 * `task_ctl` 工具：查看 / 等待 / 停止后台子 Agent 任务，读输出，向任务追加消息
 * （docs/history/wave5-plan.md §7.3，D13）。[W5-C0 桩 → W5-G]
 *
 * - 与 `task` 同进退（预设、`--tools`、`disable("task")`，见 registry.ts 的 `TOOL_COMPANIONS`）；
 * - 控制面按会话 id 取（agents/task-control.ts，注册表登记）；子会话里（depth ≥ 1）不可用——工具表
 *   与父一致，运行时拒绝；
 * - `wait` / `output` 是轮询类调用（`annotations.pollable`，重复调用检测豁免）；
 * - `send` = 续聊放后台：等价于 `task{taskId, prompt, background:true}`，完成后同样收到通知。
 * - [W7-B1] `wait` 被转后台（`background()`，TUI `Ctrl+B` / RPC `background_task`）打断时立即返回固定
 *   文案，要求模型不要再等。
 */

import { capTaskText, formatTokens, waitDetachedText } from "../agents/result.js";
import { taskControl } from "../agents/task-control.js";
import { nestedTaskRejection } from "./task.js";
import type { TaskInfo, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export const TASK_CTL_TOOL = "task_ctl";
export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 600_000;

export interface TaskCtlInput {
  action: "list" | "wait" | "stop" | "output" | "send";
  taskId?: string;
  timeoutMs?: number;
  /** send：追加给任务的消息。 */
  prompt?: string;
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

function line(task: TaskInfo, now: number): string {
  const parts = [task.taskId, task.agent, task.status];
  if (task.turns !== undefined) parts.push(`${task.turns} turns`);
  if (task.usage !== undefined) parts.push(`${formatTokens(task.usage.totalTokens)} tokens`);
  parts.push(`${Math.round(((task.endedAt ?? now) - task.startedAt) / 1000)}s`);
  if (task.background) parts.push("background");
  const text = parts.join(" · ");
  return task.description === "" ? text : `${text} — ${task.description}`;
}

async function send(input: TaskCtlInput, ctx: ToolContext): Promise<ToolResult> {
  if (input.prompt === undefined || input.prompt.trim() === "")
    return fail("send needs a non-empty prompt");
  if (ctx.spawnSubagent === undefined) return fail("Sub-agents are not available here.");
  const result = await ctx.spawnSubagent({
    prompt: input.prompt,
    taskId: input.taskId as string,
    background: true,
    parentToolCallId: ctx.toolCallId,
    signal: ctx.signal,
  });
  return { content: result.text, isError: result.isError };
}

export function createTaskCtlTool(): ToolDefinition<TaskCtlInput> {
  return {
    name: TASK_CTL_TOOL,
    label: "TaskCtl",
    description:
      "Manage sub-agent tasks started by task: list them, wait for one, stop it, read its " +
      "output, or send it a follow-up message (runs in background).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "wait", "stop", "output", "send"] },
        taskId: { type: "string", description: "Required except for list" },
        timeoutMs: { type: "number", description: `wait only (default ${DEFAULT_WAIT_MS})` },
        prompt: { type: "string", description: "send only" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    annotations: { pollable: true },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.depth >= 1)
        return fail(
          nestedTaskRejection(ctx, "task_ctl", "task_ctl is not available inside a sub-agent."),
        );
      const control = taskControl(ctx.sessionId);
      if (input.action === "list") {
        const tasks = control?.list() ?? ctx.tasks?.list() ?? [];
        if (tasks.length === 0) return { content: "No sub-agent tasks." };
        const now = Date.now();
        return { content: tasks.map((task) => line(task, now)).join("\n") };
      }
      const taskId = input.taskId;
      if (taskId === undefined || taskId === "") return fail(`${input.action} needs taskId`);
      const info = control?.get(taskId);
      if (control === undefined || info === undefined) return fail(`Unknown task ${taskId}.`);
      switch (input.action) {
        case "send":
          return send(input, ctx);
        case "output": {
          const text = control.output(taskId) ?? "";
          const head = info.status === "running" ? `Task ${taskId} is running; output so far:` : "";
          const body = capTaskText(text, info.outputFile).text || "(no output yet)";
          return { content: head === "" ? body : `${head}\n${body}` };
        }
        case "stop": {
          const result = await control.stop(taskId);
          return {
            content: `Task ${taskId} ${result?.status ?? control.get(taskId)?.status ?? "stopped"}.`,
          };
        }
        case "wait": {
          const timeout = Math.min(Math.max(input.timeoutMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
          const signal = control.detachSignal(taskId);
          const result = await control.wait(taskId, timeout, { signal });
          if (result === undefined && signal.aborted) return { content: waitDetachedText(taskId) };
          if (result === undefined) {
            const turns = control.get(taskId)?.turns ?? 0;
            return {
              content: `Task ${taskId} is still running (${turns} turns so far). Wait again or stop it.`,
            };
          }
          return {
            content: `[task ${taskId} ${result.status ?? "completed"}]\n${result.text}`,
            isError: result.isError,
          };
        }
        default:
          return fail(`unknown action ${String(input.action)}`);
      }
    },
  };
}
