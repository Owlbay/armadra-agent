/**
 * `task_ctl` 工具：查看 / 等待 / 停止后台子 Agent 任务（docs/wave5-plan.md §7.3，D13）。[W5-C0 桩]
 *
 * C0 只登记形状并让它与 `task` 同进退（预设、`--tools`、`disable("task")`，见 registry.ts 的
 * `TOOL_COMPANIONS`）；执行一律返回「尚未实现」，本体由 W5-G 实现（读 `ToolContext.tasks`）。
 * `wait` / `output` 是轮询类调用（`annotations.pollable`，重复调用检测豁免）。
 */

import type { ToolDefinition, ToolResult } from "./types.js";

export const TASK_CTL_TOOL = "task_ctl";

export interface TaskCtlInput {
  action: "list" | "wait" | "stop" | "output";
  taskId?: string;
  timeoutMs?: number;
}

export function createTaskCtlTool(): ToolDefinition<TaskCtlInput> {
  return {
    name: TASK_CTL_TOOL,
    label: "TaskCtl",
    description:
      "Manage background sub-agent tasks started by task: list, wait for one, stop it, or read its output.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "wait", "stop", "output"] },
        taskId: { type: "string", description: "Required except for list" },
        timeoutMs: { type: "number", description: "wait only" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    annotations: { pollable: true },
    execute: async (): Promise<ToolResult> => ({
      content: "task_ctl is not implemented yet in this version.",
      isError: true,
    }),
  };
}
