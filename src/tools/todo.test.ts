/**
 * [W5-F] todo 的 `update` 补丁与 `planStep`（docs/wave5-plan.md §6.1、D20）。
 */

import { describe, expect, it } from "vitest";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import {
  TODO_CUSTOM_TYPE,
  applyTodoPatches,
  createTodoTool,
  parseTodoState,
  validateTodoItems,
  type TodoItem,
} from "./todo.js";

const tool = createTodoTool();
const items: TodoItem[] = [
  { id: "S1", text: "read code", status: "in_progress", planStep: "S1" },
  { id: "S2", text: "write fix", status: "pending", planStep: "S2" },
];

describe("todo update / planStep", () => {
  it("update 按 id 改状态与文字，其余条目与 planStep 保持", async () => {
    const ctx = makeToolContext("/work");
    await tool.execute({ action: "set", items }, ctx);
    const r = await tool.execute(
      {
        action: "update",
        items: [
          { id: "S1", status: "done" },
          { id: "S2", status: "in_progress", text: "write the fix" },
        ],
      },
      ctx,
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe("Updated tasks (1/2 done):\n[x] S1. read code\n[~] S2. write the fix");
    expect(ctx.customs.at(-1)).toEqual({
      customType: TODO_CUSTOM_TYPE,
      data: {
        items: [
          { id: "S1", text: "read code", status: "done", planStep: "S1" },
          { id: "S2", text: "write the fix", status: "in_progress", planStep: "S2" },
        ],
      },
    });
  });

  it("未知 id、空补丁、非法状态报错且不落条目", async () => {
    const ctx = makeToolContext("/work");
    await tool.execute({ action: "set", items }, ctx);
    for (const updates of [[{ id: "S9", status: "done" }], [], [{ id: "S1", status: "nope" }]]) {
      const r = await tool.execute({ action: "update", items: updates as never }, ctx);
      expect(r.isError).toBe(true);
    }
    expect(ctx.customs).toHaveLength(1);
    expect(applyTodoPatches(items, [{ id: "S1", text: "" }])).toEqual({
      error: "items[0].text must be a non-empty string",
    });
  });

  it("planStep 校验与解析；schema 声明 update 与 planStep", () => {
    expect(validateTodoItems([{ id: "a", text: "x", status: "done", planStep: 3 }])).toMatch(
      /planStep/,
    );
    expect(parseTodoState({ items }).items[1]?.planStep).toBe("S2");
    expect(parseTodoState({ items: "bad" })).toEqual({ items: [] });
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(JSON.stringify(props["action"])).toContain("update");
    expect(JSON.stringify(props["items"])).toContain("planStep");
  });
});
