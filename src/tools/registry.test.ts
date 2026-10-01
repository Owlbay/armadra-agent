import { describe, expect, it } from "vitest";
import { isAmaError } from "../errors.js";
import type { ToolDefinition } from "./types.js";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import { ToolRegistry, builtinTools, createToolRegistry, executionModeOf } from "./registry.js";
import { createSkillTool } from "./skill.js";
import type { Skill } from "../skills/discover.js";

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
    const reg = createToolRegistry({ getSkills: () => [] });
    expect(reg.list()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "ls",
      "read",
      "skill",
      "task",
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
      skill: "parallel",
      task: "sequential",
      todo: "parallel",
      write: "sequential",
    });
    expect(builtinTools().map((t) => t.name)).not.toContain("skill");
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

describe("skill 工具", () => {
  const skills: Skill[] = [
    {
      name: "review",
      description: "Review code",
      location: "/s/review/SKILL.md",
      baseDir: "/s/review",
      disableModelInvocation: false,
      scope: "user",
    },
    {
      name: "deploy",
      description: "Deploy",
      location: "/s/deploy/SKILL.md",
      baseDir: "/s/deploy",
      disableModelInvocation: true,
      scope: "user",
    },
  ];
  const tool = createSkillTool({
    getSkills: () => skills,
    readFile: async (p) => `---\nname: review\n---\nBody of ${p}\n`,
  });
  const ctx = makeToolContext("/w");

  it("返回 <skill> 包裹的全文", async () => {
    const r = await tool.execute({ name: "review" }, ctx);
    expect(r.content).toBe(
      '<skill name="review" location="/s/review/SKILL.md">\nReferences are relative to /s/review.\n\n' +
        "---\nname: review\n---\nBody of /s/review/SKILL.md\n</skill>",
    );
  });

  it("不存在 → 列可用名；disable-model-invocation → 拒绝", async () => {
    const missing = await tool.execute({ name: "nope" }, ctx);
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toBe('Unknown skill "nope". Available skills: review');
    const blocked = await tool.execute({ name: "deploy" }, ctx);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("/skill:deploy");
  });
});
