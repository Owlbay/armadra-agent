import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "./types.js";
import { builtinTools } from "./registry.js";
import { TASK_AGENTS_HEADING, bindTaskBackground, createTaskTool } from "./task.js";

/** 设计 §5.6：每个内置工具「名称 + 描述 + 参数 JSON + promptSnippet + promptGuidelines」≤ 150 token。 */
const BUDGET = 150;
/**
 * [W5-G] task 是子 Agent 的统一入口（docs/wave5-plan.md §7.3、D13）：契约加了 agent / background /
 * taskId / isolation / budgetUsd 五个参数，单独给 230。
 */
const BUDGETS: Record<string, number> = { task: 230 };
/**
 * [W7-B1] 缺省后台（交互 / RPC / ACP）时 task 换成后台版描述（docs/agents-concurrency-plan.md §2.6：要说明
 * 缺省后台、何时写 background:false、不要轮询），比前台版长约 20 token；规则句已精简到一句。
 */
const TASK_BACKGROUND_BUDGET = 250;

/**
 * 按 字符数 / 4 估算 token。task 描述末尾的子 Agent 类型清单另有 400 token 预算
 * （docs/wave5-plan.md §7.3，agents/catalog.ts），不计入这里。
 */
function toolTokenEstimate(tool: ToolDefinition): number {
  const text = [
    tool.name,
    tool.description.split(TASK_AGENTS_HEADING)[0],
    JSON.stringify(tool.parameters),
    tool.promptSnippet ?? "",
    ...(tool.promptGuidelines ?? []),
  ].join("");
  return Math.ceil(text.length / 4);
}

describe("内置工具描述预算", () => {
  const tools = builtinTools();

  it("覆盖全部内置工具", () => {
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "glob",
        "ls",
        "todo",
        "task",
      ]),
    );
  });

  it(`[W7-B1] task 后台版描述 ≤ ${TASK_BACKGROUND_BUDGET} token`, () => {
    const task = createTaskTool();
    bindTaskBackground(task, true);
    expect(task.description).toContain("Runs in the background by default");
    expect(toolTokenEstimate(task as ToolDefinition)).toBeLessThanOrEqual(TASK_BACKGROUND_BUDGET);
  });

  for (const tool of tools) {
    const budget = BUDGETS[tool.name] ?? BUDGET;
    it(`${tool.name} ≤ ${budget} token`, () => {
      expect(toolTokenEstimate(tool)).toBeLessThanOrEqual(budget);
    });
  }
});
