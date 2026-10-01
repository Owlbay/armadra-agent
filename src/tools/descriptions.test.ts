import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "./types.js";
import { builtinTools } from "./registry.js";

/** 设计 §5.6：每个内置工具「名称 + 描述 + 参数 JSON + promptSnippet + promptGuidelines」≤ 150 token。 */
const BUDGET = 150;

/** 按 字符数 / 4 估算 token。 */
function toolTokenEstimate(tool: ToolDefinition): number {
  const text = [
    tool.name,
    tool.description,
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

  for (const tool of tools) {
    it(`${tool.name} ≤ ${BUDGET} token`, () => {
      expect(toolTokenEstimate(tool)).toBeLessThanOrEqual(BUDGET);
    });
  }
});
