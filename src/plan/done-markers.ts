/**
 * [W5-Z] `[DONE:<步骤>]` 文本交接（docs/guides/plan.md「交接」，D20 / R6 的回退）：活动工具集里没有 `todo` 时，
 * 批准计划的交接消息请模型每完成一步在回复里单独一行写 `[DONE:S1]`；ama 在回合结束时读这些标记，
 * 把计划生成的待办（`planStep`）标为 done、下一个未完成项转 in_progress，照常落 `ama.todo` 与发
 * `todo_updated`，界面与 RPC 的进度显示不依赖 todo 工具。
 */

import type { AgentMessage } from "../session/types.js";
import type { TodoItem } from "../tools/todo.js";

const MARKER = /^[ \t]*\[DONE:\s*([A-Za-z0-9_.-]{1,32})\s*\][ \t]*$/gm;

/** 文本里单独成行的 `[DONE:<id>]`（去重、按出现顺序）。 */
export function parseDoneMarkers(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(MARKER)) {
    const id = match[1] as string;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 按标记更新待办：只认带 `planStep` 的条目（按 `planStep` 或 `id` 匹配，大小写不敏感）。有变化时返回
 * 新清单（被标记的 done；若此时没有 in_progress，第一个 pending 转 in_progress），否则 undefined。
 */
export function applyDoneMarkers(
  items: readonly TodoItem[],
  ids: readonly string[],
): TodoItem[] | undefined {
  if (ids.length === 0) return undefined;
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  let changed = false;
  const next = items.map((item) => {
    const step = item.planStep;
    if (step === undefined || item.status === "done") return { ...item };
    if (!wanted.has(step.toLowerCase()) && !wanted.has(item.id.toLowerCase())) return { ...item };
    changed = true;
    return { ...item, status: "done" as const };
  });
  if (!changed) return undefined;
  if (!next.some((item) => item.status === "in_progress")) {
    const first = next.find((item) => item.status === "pending");
    if (first !== undefined) first.status = "in_progress";
  }
  return next;
}

/** 一条助手回复里的标记 → 新待办清单（不是助手消息、没有标记或没有变化时 undefined）。 */
export function todosFromDoneMarkers(
  message: AgentMessage,
  items: readonly TodoItem[],
): TodoItem[] | undefined {
  if (message.role !== "assistant" || items.length === 0) return undefined;
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  return applyDoneMarkers(items, parseDoneMarkers(text));
}
