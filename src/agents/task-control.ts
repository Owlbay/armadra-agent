/**
 * 会话 id → 任务控制面（`task_ctl` 工具、RPC `get_tasks`、`/tasks` 用）。[W5-G]
 *
 * 注册表（agent/subagent-registry.ts）建好后登记、会话 dispose 时注销。单独成文件是为了让
 * tools/task-ctl.ts 不 import agent/ 的实现（agent/tool-runner → tools/registry → task-ctl 会成环）。
 */

import type { SubagentResult, TaskRegistryView } from "../tools/types.js";

export interface TaskControl extends TaskRegistryView {
  /** 运行中是已有输出，结束后是最终文本。 */
  output(taskId: string): string | undefined;
  /** 等结束或超时（超时返回 undefined）；未知 taskId 抛 `task_not_found`。 */
  wait(taskId: string, timeoutMs: number): Promise<SubagentResult | undefined>;
  stop(taskId: string): Promise<SubagentResult | undefined>;
}

const controls = new Map<string, TaskControl>();

export function registerTaskControl(sessionId: string, control: TaskControl): void {
  controls.set(sessionId, control);
}

export function unregisterTaskControl(sessionId: string, control: TaskControl): void {
  if (controls.get(sessionId) === control) controls.delete(sessionId);
}

export function taskControl(sessionId: string): TaskControl | undefined {
  return controls.get(sessionId);
}
