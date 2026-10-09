import { describe, expect, it } from "vitest";
import { AgentCatalog } from "../agents/catalog.js";
import { subagentEnvironment } from "./compose-agents.js";
import type { ComposeExtensionDeps } from "./compose-extensions.js";

const env = (subagents?: Record<string, unknown>) =>
  subagentEnvironment(
    {
      assembly: { config: subagents === undefined ? {} : { subagents }, unattended: false },
    } as unknown as ComposeExtensionDeps,
    new AgentCatalog(),
  );

describe("[M-F] subagents.retainSessions", () => {
  it("配置写进注册表环境的 retain；未配置时不写（注册表用缺省 4）", () => {
    expect(env().retain).toBeUndefined();
    expect(env({ retainSessions: 0 }).retain).toBe(0);
    expect(env({ retainSessions: 8 }).retain).toBe(8);
  });
});
