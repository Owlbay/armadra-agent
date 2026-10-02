/**
 * `todo` 工具（设计 §5.2）。[B3]
 *
 * 会话内任务清单：`set` 整表替换并写 `custom{customType:"ama.todo"}` 条目（不进上下文），`get`
 * 读活动分支上最近一条。`renderTodoList()` 给 TUI / 结果文本共用。待定项「todo 是否进系统提示」：
 * 第一期不进（只有 promptSnippet 一行说明工具存在）。
 * [W5-F] `update` 按 id 局部更新（`items: {id, status?, text?}[]`，省得整表重发）；条目可带 `planStep`
 * 指回计划步骤（批准计划时由 plan 扩展生成清单）。plan 模式下 `set / update` 由权限管线拒绝。
 * 「连续多回合未更新」的提醒走 W5-H2 的提醒通道（`ama.reminder`，config `todo.reminder`）。
 */

import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

export const TODO_CUSTOM_TYPE = "ama.todo";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  /** [W5-F] 来自计划的步骤 id（`S1`…）。 */
  planStep?: string;
}

/** [W5-F] `update` 的一条补丁：按 id 改状态或文字。 */
export interface TodoPatch {
  id: string;
  status?: TodoStatus;
  text?: string;
}

export interface TodoState {
  items: TodoItem[];
}

export interface TodoInput {
  action: "set" | "get" | "update";
  /** set：整表；update：补丁（`{id, status?, text?}`）。 */
  items?: TodoItem[] | TodoPatch[];
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "done"];
const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[~]", done: "[x]" };

export function validateTodoItems(items: unknown): string | undefined {
  if (!Array.isArray(items)) return "items must be an array";
  const ids = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (typeof item !== "object" || item === null) return `items[${i}] must be an object`;
    const { id, text, status, planStep } = item as Partial<TodoItem>;
    if (typeof id !== "string" || id === "") return `items[${i}].id must be a non-empty string`;
    if (typeof text !== "string" || text === "")
      return `items[${i}].text must be a non-empty string`;
    if (!STATUSES.includes(status as TodoStatus)) {
      return `items[${i}].status must be one of ${STATUSES.join(", ")}`;
    }
    if (planStep !== undefined && typeof planStep !== "string")
      return `items[${i}].planStep must be a string`;
    if (ids.has(id)) return `duplicate id "${id}"`;
    ids.add(id);
  }
  return undefined;
}

/** `ama.todo` 条目的 data → 清单；形状不对返回空表。 */
export function parseTodoState(data: unknown): TodoState {
  if (typeof data === "object" && data !== null && Array.isArray((data as TodoState).items)) {
    const items = (data as TodoState).items;
    if (validateTodoItems(items) === undefined) return { items: items.map((it) => ({ ...it })) };
  }
  return { items: [] };
}

/** 读当前清单；无记录或形状不对返回空表。 */
export function readTodoState(ctx: Pick<ToolContext, "session">): TodoState {
  return parseTodoState(ctx.session.lastCustom(TODO_CUSTOM_TYPE));
}

/** [W5-F] 按 id 应用补丁；返回新清单或错误说明。 */
export function applyTodoPatches(
  items: readonly TodoItem[],
  updates: unknown,
): { items: TodoItem[] } | { error: string } {
  if (!Array.isArray(updates) || updates.length === 0)
    return { error: "items must be a non-empty array of {id, status?, text?}" };
  const next = items.map((it) => ({ ...it }));
  for (const [i, patch] of updates.entries()) {
    if (typeof patch !== "object" || patch === null)
      return { error: `items[${i}] must be an object` };
    const { id, status, text } = patch as Partial<TodoPatch>;
    const item = next.find((it) => it.id === id);
    if (item === undefined) return { error: `items[${i}]: no task with id "${String(id)}"` };
    if (status !== undefined) {
      if (!STATUSES.includes(status)) {
        return { error: `items[${i}].status must be one of ${STATUSES.join(", ")}` };
      }
      item.status = status;
    }
    if (text !== undefined) {
      if (typeof text !== "string" || text === "")
        return { error: `items[${i}].text must be a non-empty string` };
      item.text = text;
    }
  }
  return { items: next };
}

export function renderTodoList(items: readonly TodoItem[]): string[] {
  if (items.length === 0) return ["(no tasks)"];
  return items.map((it) => `${MARK[it.status]} ${it.id}. ${it.text}`);
}

function summary(items: readonly TodoItem[]): string {
  const done = items.filter((it) => it.status === "done").length;
  return `${done}/${items.length} done`;
}

export async function executeTodo(input: TodoInput, ctx: ToolContext): Promise<ToolResult> {
  if (input.action === "get") {
    const state = readTodoState(ctx);
    return {
      content: [`Tasks (${summary(state.items)}):`, ...renderTodoList(state.items)].join("\n"),
      details: state,
    };
  }
  let state: TodoState;
  if (input.action === "update") {
    const patched = applyTodoPatches(readTodoState(ctx).items, input.items);
    if ("error" in patched) return { content: patched.error, isError: true };
    state = patched;
  } else if (input.action === "set") {
    const problem = validateTodoItems(input.items ?? []);
    if (problem !== undefined) return { content: problem, isError: true };
    state = { items: ((input.items ?? []) as TodoItem[]).map((it) => ({ ...it })) };
  } else {
    return { content: 'action must be "set", "update" or "get"', isError: true };
  }
  ctx.session.appendCustom(TODO_CUSTOM_TYPE, state);
  return {
    content: [`Updated tasks (${summary(state.items)}):`, ...renderTodoList(state.items)].join(
      "\n",
    ),
    details: state,
  };
}

export function createTodoTool(): ToolDefinition<TodoInput> {
  return {
    name: "todo",
    label: "Todo",
    description:
      "Session task list: `set` replaces all items, `update` changes items by id (only given fields), `get` reads.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "update", "get"] },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
              planStep: { type: "string" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    promptSnippet: "todo: track multi-step work",
    execute: executeTodo,
    renderResult: (result) => {
      const state = result.details as TodoState | undefined;
      return state && Array.isArray(state.items) ? renderTodoList(state.items) : [];
    },
  };
}
