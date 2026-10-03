/**
 * 第五波配置键（docs/wave5-plan.md §9）：校验、项目级限制、累加型列表、agents.<id> 取值。[W5-C0]
 * 两边一致性（validateConfig ↔ config.schema.json）在 json-schema.test.ts 的正反例里。
 */

import { describe, expect, it } from "vitest";
import { mergeConfigLayers, restrictProjectConfig } from "./merge.js";
import { validateConfig } from "./schema.js";
import { agentEntry, type AmaConfig } from "./types.js";

describe("第五波配置键的校验", () => {
  it("未知子字段只是 warning", () => {
    const diagnostics = validateConfig({
      version: 1,
      plan: { bogus: 1 },
      agents: { claude: { x: 1 } },
    });
    expect(diagnostics.map((d) => [d.severity, d.path])).toEqual([
      ["warning", "plan.bogus"],
      ["warning", "agents.claude.x"],
    ]);
  });

  it("类型错误是 error，并指到字段", () => {
    const diagnostics = validateConfig({ version: 1, limits: { maxCostUsd: "1" } });
    expect(diagnostics).toEqual([
      { severity: "error", path: "limits.maxCostUsd", message: "应为数字" },
    ]);
  });
});

describe("第五波键的层级", () => {
  const project = (config: Partial<AmaConfig>) => ({ version: 1 as const, ...config });

  it("项目级 plan.bash 只能更严；plan 其它子键忽略", () => {
    const stricter = restrictProjectConfig(
      project({ plan: { bash: "deny", model: "x/y" } }),
      "default",
    );
    expect(stricter.accepted.plan).toEqual({ bash: "deny" });
    expect(stricter.warnings.join("\n")).toContain("plan.model");
    const wider = restrictProjectConfig(project({ plan: { bash: "ask" } }), "default");
    expect(wider.accepted.plan).toBeUndefined();
    expect(wider.warnings.join("\n")).toContain("只能收紧 plan.bash");
  });

  it("项目级接受 reminders 与 ui.statusLine；compaction.prune / pruneExclude 与其它新段忽略", () => {
    const result = restrictProjectConfig(
      project({
        reminders: { todo: false },
        ui: { statusLine: "compact" },
        compaction: { enabled: false, prune: { keepResults: 1 }, pruneExclude: ["bash"] },
        limits: { maxTurns: 3 },
        agents: { maxConcurrent: 9 },
        fallbackModel: "a/b",
      }),
      "default",
    );
    expect(result.accepted).toEqual({
      reminders: { todo: false },
      ui: { statusLine: "compact" },
      compaction: { enabled: false },
    });
    const text = result.warnings.join("\n");
    for (const key of ["compaction.prune", "limits", "agents", "fallbackModel"])
      expect(text).toContain(key);
  });

  it("[W7-B2] 项目级接受 subagents.background / autoBackgroundAfterMs；并发与模型仍只认用户级", () => {
    const result = restrictProjectConfig(
      project({
        subagents: {
          background: "never",
          autoBackgroundAfterMs: 60000,
          maxConcurrent: 64,
          defaultModel: "x/y",
        },
      }),
      "default",
    );
    expect(result.accepted).toEqual({
      subagents: { background: "never", autoBackgroundAfterMs: 60000 },
    });
    const text = result.warnings.join("\n");
    expect(text).toContain("subagents.maxConcurrent");
    expect(text).toContain("subagents.defaultModel");
    const merged = mergeConfigLayers({
      user: project({ subagents: { maxConcurrent: 2, background: "always" } }),
      project: project({ subagents: { background: "never" } }),
    });
    expect(merged.config.subagents).toEqual({ maxConcurrent: 2, background: "never" });
  });

  it("agents.dirs 跨层累加；plan.bash 收紧以用户级为基准", () => {
    const merged = mergeConfigLayers({
      user: project({ agents: { dirs: ["/u"] }, plan: { bash: "ask" } }),
      profile: project({ agents: { dirs: ["/p"] } }),
      hasProfile: true,
      project: project({ plan: { bash: "readonly" } }),
    });
    expect(merged.config.agents?.dirs).toEqual(["/u", "/p"]);
    expect(merged.config.plan?.bash).toBe("readonly");
  });

  it("agentEntry 跳过保留键", () => {
    const agents = { maxConcurrent: 2, dirs: ["/a"], claude: { maxConcurrent: 1 } };
    expect(agentEntry(agents, "claude")).toEqual({ maxConcurrent: 1 });
    expect(agentEntry(agents, "dirs")).toBeUndefined();
    expect(agentEntry(agents, "codex")).toBeUndefined();
    expect(agentEntry(undefined, "claude")).toBeUndefined();
  });
});

describe("models.enabled", () => {
  it("provider/model[@channel] 与 provider/* 合法；其它报错到具体下标；项目级忽略", () => {
    expect(
      validateConfig({
        version: 1,
        models: { enabled: ["openai/gpt-5", "relay/kimi@messages", "packy/*", "or/a/b"] },
      }).filter((d) => d.severity === "error"),
    ).toEqual([]);
    const bad = validateConfig({ version: 1, models: { enabled: ["gpt-5", 3] } } as never);
    expect(bad.filter((d) => d.severity === "error").map((d) => d.path)).toEqual([
      "models.enabled",
      "models.enabled[0]",
    ]);
    const merged = mergeConfigLayers({
      user: { version: 1, models: { enabled: ["openai/gpt-5"] } },
      project: { version: 1, models: { enabled: ["x/y"] } } as AmaConfig,
    });
    expect(merged.config.models?.enabled).toEqual(["openai/gpt-5"]);
  });
});
