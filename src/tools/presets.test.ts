import { describe, expect, it } from "vitest";
import { validateConfig } from "../config/schema.js";
import { mergeConfigLayers } from "../config/merge.js";
import type { AmaConfig } from "../config/types.js";
import {
  PresetToolRegistry,
  applyToolAdjustments,
  effectiveCodemodeMode,
  resolvePreset,
} from "./presets.js";
import { builtinTools } from "./registry.js";
import type { ToolDefinition } from "./types.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    permission: "read",
    execute: async () => ({ content: name }),
  };
}

const BUILTIN = new Set(builtinTools().map((t) => t.name));
const available =
  (extra: string[] = []) =>
  (name: string) =>
    BUILTIN.has(name) || extra.includes(name);

function cfg(tools: NonNullable<AmaConfig["tools"]>, codemode?: AmaConfig["codemode"]): AmaConfig {
  return { version: 1, tools, ...(codemode !== undefined ? { codemode } : {}) };
}

describe("工具预设", () => {
  it("default / minimal / coordinator 的内置工具", () => {
    expect(resolvePreset({ config: cfg({}), available: available() }).builtin).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
    expect(
      resolvePreset({ config: cfg({ preset: "minimal" }), available: available() }).builtin,
    ).toEqual(["bash", "edit", "read", "write"]);
    expect(
      resolvePreset({ config: cfg({ preset: "coordinator" }), available: available() }).builtin,
    ).toEqual(["read"]);
  });

  it("codemode 预设：有 codemode 工具 → only；没有 → 回退 default 并 warning", () => {
    const withTool = resolvePreset({
      config: cfg({ preset: "codemode" }),
      available: available(["codemode"]),
    });
    expect(withTool).toMatchObject({ preset: "codemode", codemode: "only", builtin: ["codemode"] });
    const without = resolvePreset({ config: cfg({ preset: "codemode" }), available: available() });
    expect(without.preset).toBe("default");
    expect(without.codemode).toBe("off");
    expect(without.builtin).toContain("grep");
    expect(without.warnings[0]).toContain("回退到 default");
  });

  it("codemode 开关跟随预设，显式 codemode.mode 覆盖", () => {
    expect(effectiveCodemodeMode(cfg({}))).toBe("off");
    expect(effectiveCodemodeMode(cfg({ preset: "minimal" }))).toBe("off");
    expect(effectiveCodemodeMode(cfg({ preset: "codemode" }))).toBe("only");
    expect(effectiveCodemodeMode(cfg({ preset: "codemode" }, { mode: "on" }))).toBe("on");
    const on = resolvePreset({
      config: cfg({ preset: "minimal" }, { mode: "on" }),
      available: available(["codemode"]),
    });
    expect(on.builtin).toEqual(["bash", "codemode", "edit", "read", "write"]);
  });

  it("tools.default：+ / - 微调、纯名字整组替换、未知名 warning", () => {
    expect(applyToolAdjustments(["read", "bash"], ["+ls", "-bash"])).toEqual(["read", "ls"]);
    expect(applyToolAdjustments(["read", "bash"], ["grep", "read", "+todo"])).toEqual([
      "grep",
      "read",
      "todo",
    ]);
    const r = resolvePreset({
      config: cfg({ preset: "minimal", default: ["+task", "+nope", "-bash"] }),
      available: available(),
    });
    expect(r.builtin).toEqual(["edit", "read", "task", "write"]);
    expect(r.warnings).toEqual(["tools.default：未知工具 nope，已忽略"]);
  });

  it("tools.default 进配置校验；项目级不能设", () => {
    expect(validateConfig({ version: 1, tools: { default: ["+ls"] } })).toEqual([]);
    expect(validateConfig({ version: 1, tools: { default: "ls" } })[0]?.message).toBeDefined();
    const merged = mergeConfigLayers({
      user: { version: 1, tools: { default: ["+ls"] } },
      project: { version: 1, tools: { default: ["+task"] } },
    });
    expect(merged.config.tools?.default).toEqual(["+ls"]);
    expect(merged.warnings.join("\n")).toContain("tools.default");
  });
});

describe("PresetToolRegistry", () => {
  function registry(): PresetToolRegistry {
    const reg = new PresetToolRegistry();
    for (const t of builtinTools()) reg.register(t, "builtin");
    return reg;
  }

  it("活动集 = 预设内置工具 + 全部宿主工具；按名排序", () => {
    const reg = registry();
    reg.setPresetTools(["read"]);
    reg.register(tool("canvas_send"), "host");
    expect(reg.active().map((t) => t.name)).toEqual(["canvas_send", "read"]);
    expect(reg.get("bash")).toBeDefined();
  });

  it("setActive（--tools）整组替换；disable 仍生效", () => {
    const reg = registry();
    reg.setPresetTools(["read", "bash"]);
    reg.register(tool("canvas_send"), "host");
    reg.disable("bash");
    expect(reg.active().map((t) => t.name)).toEqual(["canvas_send", "read"]);
    reg.setActive(["ls", "read"]);
    expect(reg.hasExplicitActive).toBe(true);
    expect(reg.active().map((t) => t.name)).toEqual(["ls", "read"]);
  });

  it("onRegister 通知后注册的工具", () => {
    const reg = registry();
    const seen: string[] = [];
    const off = reg.onRegister((t, source) => seen.push(`${source}:${t.name}`));
    reg.register(tool("canvas_a"), "host");
    off();
    reg.register(tool("canvas_b"), "host");
    expect(seen).toEqual(["host:canvas_a"]);
  });
});
