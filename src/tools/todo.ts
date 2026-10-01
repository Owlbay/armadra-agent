/**
 * `todo` 工具（设计 §5.2）。[B3]
 *
 * 会话内任务清单：`set` 整表替换并写 `custom{customType:"ama.todo"}` 条目（不进上下文），`get`
 * 读活动分支上最近一条。`renderTodoList()` 给 TUI / 结果文本共用。待定项「todo 是否进系统提示」：
 * 第一期不进（只有 promptSnippet 一行说明工具存在）。
 */

import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

export const TODO_CUSTOM_TYPE = "ama.todo";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export interface TodoState {
  items: TodoItem[];
}

export interface TodoInput {
  action: "set" | "get";
  items?: TodoItem[];
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "done"];
const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[~]", done: "[x]" };

export function validateTodoItems(items: unknown): string | undefined {
  if (!Array.isArray(items)) return "items must be an array";
  const ids = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (typeof item !== "object" || item === null) return `items[${i}] must be an object`;
    const { id, text, status } = item as Partial<TodoItem>;
    if (typeof id !== "string" || id === "") return `items[${i}].id must be a non-empty string`;
    if (typeof text !== "string" || text === "")
      return `items[${i}].text must be a non-empty string`;
    if (!STATUSES.includes(status as TodoStatus)) {
      return `items[${i}].status must be one of ${STATUSES.join(", ")}`;
    }
    if (ids.has(id)) return `duplicate id "${id}"`;
    ids.add(id);
  }
  return undefined;
}

/** 读当前清单；无记录或形状不对返回空表。 */
export function readTodoState(ctx: Pick<ToolContext, "session">): TodoState {
  const data = ctx.session.lastCustom(TODO_CUSTOM_TYPE);
  if (typeof data === "object" && data !== null && Array.isArray((data as TodoState).items)) {
    const items = (data as TodoState).items;
    if (validateTodoItems(items) === undefined) return { items: items.map((it) => ({ ...it })) };
  }
  return { items: [] };
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
  if (input.action !== "set") return { content: 'action must be "set" or "get"', isError: true };
  const problem = validateTodoItems(input.items ?? []);
  if (problem !== undefined) return { content: problem, isError: true };
  const state: TodoState = { items: (input.items ?? []).map((it) => ({ ...it })) };
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
      "Track a task list for this session. `set` replaces the whole list; `get` returns it. " +
      "Use it to plan multi-step work and mark progress.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "get"], description: "set or get" },
        items: {
          type: "array",
          description: "Full task list (for set)",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["id", "text", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    promptSnippet: "todo: keep a task list for multi-step work",
    execute: executeTodo,
    renderResult: (result) => {
      const state = result.details as TodoState | undefined;
      return state && Array.isArray(state.items) ? renderTodoList(state.items) : [];
    },
  };
}
