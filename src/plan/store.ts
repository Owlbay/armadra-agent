/**
 * 计划的持久化：会话条目的读取与计划文件导出（docs/wave5-plan.md §6.3）。[W5-F]
 *
 * - 权威数据在会话 JSONL：`custom{ama.plan}`（只追加：状态变化再记一条，同 id 取分支上最后一条）、
 *   `custom{ama.plan_state}`（进入 / 退出 plan）。
 * - 文件只作导出：缺省 `<dataDir>/plans/<sessionId>-v<N>.md`；`plan.directory` 可指到项目内
 *   （相对路径按项目根解析，必须在项目根之内，否则 warning 回落缺省）。由 ama 进程写，不经工具调用。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { PlanData, PlanStateData, TodoItemView } from "../agent/types.js";
import type { PermissionMode } from "../permissions/types.js";
import type { SessionEntry } from "../session/types.js";
import { TODO_CUSTOM_TYPE, parseTodoState } from "../tools/todo.js";

export const PLAN_CUSTOM_TYPE = "ama.plan";
export const PLAN_STATE_CUSTOM_TYPE = "ama.plan_state";

/**
 * `ama.plan_state` 的落盘形状：契约 `PlanStateData` 加两项可选的本地字段，记下进入 plan 时切走的
 * 执行模型（`plan.model` 配置时），resume 后批准仍能切回。读到旧条目时缺省。
 */
export interface PlanStateRecord extends PlanStateData {
  executionModel?: string;
  executionThinking?: string;
}

function customData(entry: SessionEntry, customType: string): unknown {
  return entry.type === "custom" && entry.customType === customType ? entry.data : undefined;
}

function isPlanData(value: unknown): value is PlanData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PlanData>;
  return (
    typeof v.id === "string" &&
    typeof v.version === "number" &&
    typeof v.markdown === "string" &&
    Array.isArray(v.steps)
  );
}

/** 分支上最后一条 `ama.plan`（任意状态）；`planId` 给定时取该计划的最后一条。 */
export function latestPlan(branch: readonly SessionEntry[], planId?: string): PlanData | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const data = customData(branch[i]!, PLAN_CUSTOM_TYPE);
    if (isPlanData(data) && (planId === undefined || data.id === planId)) return data;
  }
  return undefined;
}

/** 分支上已用过的最大版本号（文件名 `-v<N>` 在会话内单调）。 */
export function maxPlanVersion(branch: readonly SessionEntry[]): number {
  let max = 0;
  for (const entry of branch) {
    const data = customData(entry, PLAN_CUSTOM_TYPE);
    if (isPlanData(data)) max = Math.max(max, data.version);
  }
  return max;
}

export function latestPlanState(branch: readonly SessionEntry[]): PlanStateRecord | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const data = customData(branch[i]!, PLAN_STATE_CUSTOM_TYPE);
    if (
      typeof data === "object" &&
      data !== null &&
      typeof (data as PlanStateData).active === "boolean"
    )
      return data as PlanStateRecord;
  }
  return undefined;
}

/** 分支上的当前 todo 清单（RPC `get_todos`、`todo_updated` 事件）。 */
export function currentTodos(branch: readonly SessionEntry[]): TodoItemView[] {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "custom" && entry.customType === TODO_CUSTOM_TYPE)
      return parseTodoState(entry.data).items;
  }
  return [];
}

/** 批准时的执行模式：显式指定 > 进入 plan 前的模式；进入前就是 plan 时用 default。 */
export function executionMode(
  requested: PermissionMode | undefined,
  prePlanMode: PermissionMode | undefined,
): PermissionMode {
  const mode = requested ?? prePlanMode ?? "default";
  return mode === "plan" ? "default" : mode;
}

/** 计划文件目录：`plan.directory` 在项目根之内才用，否则 warning 回落 `<dataDir>/plans`。 */
export function resolvePlanDirectory(
  configured: string | undefined,
  projectRoot: string,
  dataDir: string,
): { dir: string; warning?: string } {
  const fallback = join(dataDir, "plans");
  if (configured === undefined || configured.trim() === "") return { dir: fallback };
  const dir = resolve(projectRoot, configured);
  const rel = relative(resolve(projectRoot), dir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      dir: fallback,
      warning: `plan.directory ${configured} 不在项目根 ${projectRoot} 之内，计划文件改写到 ${fallback}`,
    };
  }
  return { dir };
}

/** 写 `<dir>/<sessionId>-v<N>.md`，返回绝对路径。 */
export function writePlanFile(
  dir: string,
  sessionId: string,
  version: number,
  markdown: string,
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}-v${version}.md`);
  writeFileSync(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
  return file;
}
