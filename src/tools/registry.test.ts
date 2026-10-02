import { describe, expect, it } from "vitest";
import { isAmaError } from "../errors.js";
import type { ToolDefinition } from "./types.js";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import { ToolRegistry, builtinTools, createToolRegistry, executionModeOf } from "./registry.js";

function fakeTool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    permission: "read",
    execute: async () => ({ content: name }),
    ...extra,
  };
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return isAmaError(err) ? err.code : "other";
  }
  return undefined;
}

describe("ToolRegistry", () => {
  it("内置工具齐全、按名排序、执行模式缺省", () => {
    const reg = createToolRegistry();
    expect(reg.list()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "ls",
      "read",
      "task",
      "task_ctl",
      "todo",
      "write",
    ]);
    const modes = Object.fromEntries(reg.active().map((t) => [t.name, executionModeOf(t)]));
    expect(modes).toEqual({
      bash: "sequential",
      edit: "sequential",
      glob: "parallel",
      grep: "parallel",
      ls: "parallel",
      read: "parallel",
      task: "parallel", // [W5-G] 同轮多个 task 并行（D23）
      task_ctl: "parallel",
      todo: "parallel",
      write: "sequential",
    });
    expect(builtinTools().map((t) => t.name)).not.toContain("skill");
    expect(builtinTools().length).toBe(10);
    expect(executionModeOf({ permission: "execute" })).toBe("sequential");
  });

  it("同名 → tool_exists；非法名 / 非子集 schema → invalid_arguments", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("canvas_send"), "host");
    expect(codeOf(() => reg.register(fakeTool("canvas_send"), "host"))).toBe("tool_exists");
    expect(codeOf(() => reg.register(fakeTool("Bad"), "host"))).toBe("invalid_arguments");
    expect(
      codeOf(() =>
        reg.register(
          fakeTool("weird", { parameters: { type: "object", oneOf: [] } as never }),
          "sdk",
        ),
      ),
    ).toBe("invalid_arguments");
    expect(reg.sourceOf("canvas_send")).toBe("host");
  });

  it("disable 先于注册也生效；setActive 限定活动集", () => {
    const reg = new ToolRegistry();
    reg.disable("task");
    reg.register(fakeTool("task"), "builtin");
    reg.register(fakeTool("read"), "builtin");
    reg.register(fakeTool("grep"), "builtin");
    expect(reg.list()).toEqual(["grep", "read"]);
    expect(reg.get("task")).toBeUndefined();
    expect(reg.isDisabled("task")).toBe(true);
    reg.setActive(["read"]);
    expect(reg.active().map((t) => t.name)).toEqual(["read"]);
    expect(codeOf(() => reg.setActive(["task"]))).toBe("tool_not_found");
    reg.disable("read");
    expect(reg.active()).toEqual([]);
  });

  it("config.tools.disabled", () => {
    const reg = createToolRegistry({ disabled: ["bash", "task"] });
    expect(reg.list()).not.toContain("bash");
    expect(reg.list()).not.toContain("task");
  });
});

describe("伴随工具（W5-C0：task_ctl 与 task 同进退）", () => {
  it("disable(task) 一并禁用 task_ctl；setActive 选 task 时带上 task_ctl", () => {
    const reg = createToolRegistry();
    reg.setActive(["read", "task"]);
    expect(reg.active().map((t) => t.name)).toEqual(["read", "task", "task_ctl"]);
    reg.disable("task");
    expect(reg.list()).not.toContain("task_ctl");
    expect(reg.active().map((t) => t.name)).toEqual(["read"]);
  });

  it("task_ctl 桩：轮询类、执行返回尚未实现", async () => {
    const tool = builtinTools().find((t) => t.name === "task_ctl");
    expect(tool?.annotations?.pollable).toBe(true);
    const result = await tool!.execute({ action: "list" }, {} as never);
    expect(result).toMatchObject({ isError: true });
    expect(String(result.content)).toContain("not implemented");
  });
});
