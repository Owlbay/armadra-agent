import { describe, expect, it } from "vitest";
import { stubTool } from "../agent/testing/stubs.js";
import { emptyComposeState } from "../cli/compose-session.js";
import { createTools, type ToolFactory } from "../cli/compose.js";
import type { AmaConfig } from "../config/types.js";
import { CODEMODE_TOOL } from "../tools/presets.js";
import type { ToolDefinition } from "../tools/types.js";

/** 桩 codemode 工厂：模式为 off 时不注册（与真实工厂同一约定）。 */
const stubCodemode: ToolFactory = (ctx) => {
  const mode =
    ctx.config.codemode?.mode ?? (ctx.config.tools?.preset === "codemode" ? "only" : "off");
  return mode === "off" ? undefined : stubTool({ name: CODEMODE_TOOL, permission: "execute" });
};

function tools(config: Omit<AmaConfig, "version">, extra: ToolDefinition[] = []) {
  const state = emptyComposeState();
  const registry = createTools(
    { config: { version: 1, ...config }, cwd: "/w", mode: "print" },
    { toolFactories: [stubCodemode], extraTools: extra },
    state,
  );
  return { registry, warnings: state.warnings };
}

const host = () => stubTool({ name: "canvas_send" }) as ToolDefinition;

describe("codemode 模式", () => {
  it("off：不注册 codemode，描述不变", () => {
    const { registry } = tools({});
    expect(registry.get(CODEMODE_TOOL)).toBeUndefined();
    expect(registry.list()).not.toContain(CODEMODE_TOOL);
    expect(registry.get("read")?.description).not.toContain("codemode");
  });

  it("only（codemode 预设）：活动集只有 codemode，宿主工具也不直接暴露但仍已注册", () => {
    const { registry, warnings } = tools({ tools: { preset: "codemode" } }, [host()]);
    expect(registry.active().map((t) => t.name)).toEqual([CODEMODE_TOOL]);
    expect(registry.list()).toEqual(expect.arrayContaining(["bash", "canvas_send", "ls", "task"]));
    expect(warnings).toEqual([]);
    expect(registry.get("read")?.description).not.toContain("codemode");
    // 会话创建后宿主再注册的工具：同样不进活动集
    registry.register(stubTool({ name: "canvas_team" }) as ToolDefinition, "host");
    expect(registry.active().map((t) => t.name)).toEqual([CODEMODE_TOOL]);
  });

  it("on：预设工具 + codemode，其它工具描述不变（不再追加提示）", () => {
    const { registry } = tools({ codemode: { mode: "on" } }, [host()]);
    expect(registry.active().map((t) => t.name)).toEqual([
      "bash",
      "canvas_send",
      CODEMODE_TOOL,
      "edit",
      "glob",
      "grep",
      "read",
      "todo",
      "write",
    ]);
    expect(registry.get("read")?.description).not.toContain("codemode");
    expect(registry.get("canvas_send")?.description).toBe("canvas_send test tool");
    expect(registry.get(CODEMODE_TOOL)?.description).toBe("codemode test tool");
  });

  it("codemode 工具不可用时 codemode 预设回退到 default 并 warning", () => {
    const state = emptyComposeState();
    const registry = createTools(
      { config: { version: 1, tools: { preset: "codemode" } }, cwd: "/w", mode: "print" },
      { toolFactories: [] },
      state,
    );
    expect(registry.active().map((t) => t.name)).toContain("grep");
    expect(state.warnings.join("\n")).toMatch(/不可用.*回退到 default/);
  });
});
