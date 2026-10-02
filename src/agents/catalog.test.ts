import { describe, expect, it } from "vitest";
import { assembleSections, definedSections } from "../agent/system-prompt.js";
import { BUILTIN_AGENTS, SUBAGENT_ROLE_PREAMBLE, agentRole } from "./builtin.js";
import { AgentCatalog, resolveAgentModel } from "./catalog.js";
import type { AgentDefinition } from "./types.js";

const custom = (name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  ...BUILTIN_AGENTS[0]!,
  name,
  description: `${name} desc`,
  source: "user",
  filePath: `/a/${name}.md`,
  ...extra,
});

describe("内置类型与目录", () => {
  it("general / explore / plan；explore 与 plan 强制 plan 模式、工具表不变", () => {
    const catalog = new AgentCatalog();
    expect(catalog.names()).toEqual(["general", "explore", "plan"]);
    expect(catalog.get("general")?.permissionMode).toBe("inherit");
    expect(catalog.get("explore")).toMatchObject({ permissionMode: "plan", source: "builtin" });
    expect(catalog.get("plan")?.permissionMode).toBe("plan");
    for (const agent of BUILTIN_AGENTS) {
      expect(agent.tools).toBeUndefined();
      expect(agent.disallowedTools).toBeUndefined();
    }
  });

  it("发现的同名定义覆盖内置；外部类型 add 不覆盖已有", () => {
    const catalog = new AgentCatalog([custom("explore"), custom("reviewer")]);
    expect(catalog.get("explore")?.source).toBe("user");
    expect(catalog.add(custom("reviewer", { runner: "claude" }))).toBe(false);
    expect(catalog.add(custom("claude", { runner: "claude", source: "host" }))).toBe(true);
    expect(catalog.infos().find((i) => i.name === "claude")).toMatchObject({ runner: "claude" });
  });

  it("describe：预算内列 name: description，超出只列名字", () => {
    const catalog = new AgentCatalog([custom("reviewer")]);
    expect(catalog.describe()).toContain("- reviewer: reviewer desc");
    const many = new AgentCatalog(
      Array.from({ length: 30 }, (_, i) => custom(`a${i}`, { description: "x".repeat(100) })),
    );
    const text = many.describe();
    expect(text).not.toContain("xxxx");
    expect(text.startsWith("general, explore, plan, a0")).toBe(true);
  });

  it("模型：参数 > 定义 > agents.<name>.model > subagents.defaultModel > 继承；别名", () => {
    const general = BUILTIN_AGENTS[0]!;
    const config = {
      agents: { general: { model: "p/cfg" } },
      subagents: { defaultModel: "p/default" },
      models: { aliases: { fast: "p/cheap" } },
    };
    expect(resolveAgentModel(general, "p/arg", config).ref).toBe("p/arg");
    expect(resolveAgentModel(custom("x", { model: "p/own" }), undefined, config).ref).toBe("p/own");
    expect(resolveAgentModel(general, undefined, config).ref).toBe("p/cfg");
    expect(resolveAgentModel(custom("y"), undefined, config).ref).toBe("p/default");
    expect(resolveAgentModel(custom("y"), undefined, {}).ref).toBeUndefined();
    expect(resolveAgentModel(custom("z", { model: "fast" }), undefined, config).ref).toBe(
      "p/cheap",
    );
    const missing = resolveAgentModel(custom("z", { model: "strong" }), undefined, config);
    expect(missing.ref).toBeUndefined();
    expect(missing.warning).toMatch(/models.aliases.strong/);
  });
});

describe("系统提示 role 节（子会话）", () => {
  it("role 在最末：父会话的全部节是子会话的前缀；主会话不出现 role", () => {
    const base = { tools: [], cwd: "/w", hostInstructions: ["host text"] };
    const parent = definedSections(assembleSections(base));
    const child = definedSections(
      assembleSections({ ...base, role: agentRole(BUILTIN_AGENTS[1]!) }),
    );
    expect(Object.keys(parent)).not.toContain("role");
    expect(Object.keys(child)).toEqual([...Object.keys(parent), "role"]);
    for (const [name, text] of Object.entries(parent)) expect(child[name]).toBe(text);
    expect(child["role"]).toContain(SUBAGENT_ROLE_PREAMBLE);
    expect(child["role"]).toContain("Locate, do not review");
    expect(agentRole({ prompt: "" })).toBe(SUBAGENT_ROLE_PREAMBLE);
  });
});
