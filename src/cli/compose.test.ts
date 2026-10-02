import { afterEach, describe, expect, it } from "vitest";
import {
  composeHarness,
  recordingHost,
  type ComposeHarness,
} from "../../test/helpers/compose-harness.js";
import { AgentSessionImpl } from "../agent/session.js";
import type { SystemMessage } from "../ai/types.js";
import { buildRules, type ComposeOptions } from "./compose.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

function nodeHook(name: string, source: string): string {
  const file = h.home.write(`scripts/${name}.cjs`, source).replace(/\\/g, "/");
  return `"${process.execPath.replace(/\\/g, "/")}" "${file}"`;
}

function firstSystem(index = 0): SystemMessage {
  const message = h.fake.calls[index]?.context.messages[0];
  if (message?.role !== "system") throw new Error("no system message");
  return message;
}

describe("createRuntimeDeps + bootstrap", () => {
  it("fake/echo 一次往返：AgentSessionImpl、宿主事件顺序、hook_executed 恰一次", async () => {
    h = composeHarness();
    const host = recordingHost(h.home);
    h.home.write("home/.config/ama/hooks.json", {
      version: 1,
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: nodeHook("ok", "") }] }] },
    });
    const runtime = await h.boot(["--model", "fake/echo", "--host", host.path]);
    expect(runtime.session).toBeInstanceOf(AgentSessionImpl);
    await runtime.session.prompt("hi");
    expect(runtime.session.getLastAssistantText()).toBe("hi");
    const names = host.events().map((e) => e.name);
    const order = ["before_agent_start", "agent_start", "agent_end", "agent_settled"].map((n) =>
      names.indexOf(n),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(names.filter((n) => n === "hook_executed")).toHaveLength(1);
    expect(names[0]).toBe("session_start");
    await runtime.dispose();
    expect(host.events().at(-1)?.name).toBe("session_shutdown");
  });

  it("工具预设决定活动集；--tools 整组替换；codemode 预设只给 codemode，缺工具时回退并 warning", async () => {
    h = composeHarness();
    const names = async (argv: string[], options?: ComposeOptions) => {
      const runtime = await h.boot(["--model", "fake/echo", ...argv], options);
      const tools = runtime.session.getTools().map((t) => t.name);
      await runtime.dispose();
      return { tools, warnings: runtime.warnings };
    };
    expect((await names([])).tools).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "read",
      "todo",
      "write",
    ]);
    expect((await names(["--tools-preset", "minimal"])).tools).toEqual([
      "bash",
      "edit",
      "read",
      "write",
    ]);
    expect((await names(["--tools-preset", "coordinator"])).tools).toEqual(["read"]);
    expect((await names(["--tools", "read,ls"])).tools).toEqual(["ls", "read"]);
    expect((await names(["--tools-preset", "codemode"])).tools).toEqual(["codemode"]);
    expect((await names(["--codemode", "on", "--tools-preset", "minimal"])).tools).toEqual([
      "bash",
      "codemode",
      "edit",
      "read",
      "write",
    ]);
    const codemode = await names(["--tools-preset", "codemode"], { toolFactories: [] });
    expect(codemode.tools).toContain("grep");
    expect(codemode.warnings.join("\n")).toContain("回退到 default");
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      tools: { preset: "minimal", default: ["+task", "-bash"] },
    });
    // [W5-C0] task_ctl 随 task 暴露
    expect((await names([])).tools).toEqual(["edit", "read", "task", "task_ctl", "write"]);
  });

  it("权限：内置 deny 按 builtinDeny 过滤，非法规则 warning 后跳过", async () => {
    h = composeHarness();
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      permission: { builtinDeny: ["read(**/.ssh/**)"], allow: ["bash(git status*)", "("] },
    });
    const runtime = await h.boot(["--model", "fake/echo"]);
    const raws = runtime.permission.rules.map((r) => r.raw);
    expect(raws).toContain("write(**/.git/**)");
    expect(raws).not.toContain("read(**/.ssh/**)");
    expect(raws).toContain("bash(git status*)");
    expect(runtime.warnings.join("\n")).toContain("权限规则");
    await runtime.dispose();
    expect(buildRules([], false, () => undefined)).toEqual([]);
  });

  it("系统提示：AGENTS.md 与 --instructions 进 project_context，Skill 索引用 read，SessionStart 上下文进 hooks 节", async () => {
    h = composeHarness();
    h.home.write("work/AGENTS.md", "project rules");
    h.home.write("work/extra.md", "extra instructions");
    h.home.write(
      "home/.config/ama/skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\nDo a review.\n",
    );
    const context = JSON.stringify({ additionalContext: "from session start" });
    h.home.write("home/.config/ama/hooks.json", {
      version: 1,
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: nodeHook("start", `process.stdout.write(${JSON.stringify(context)})`),
              },
            ],
          },
        ],
      },
    });
    const runtime = await h.boot(["--model", "fake/echo", "--instructions", "extra.md"]);
    await runtime.session.prompt("hi");
    const sections = firstSystem().sections;
    expect(sections["project_context"]).toContain("project rules");
    expect(sections["project_context"]).toContain("extra instructions");
    expect(sections["skills"]).toContain("Use the read tool");
    expect(sections["skills"]).toContain("<name>review</name>");
    expect(sections["hooks"]).toBe("from session start");
    await runtime.dispose();
  });

  it("/skill: 与提示模板展开；未知 Skill 报错列出可用名", async () => {
    h = composeHarness();
    h.home.write(
      "home/.config/ama/skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\nDo a review.\n",
    );
    h.home.write("home/.config/ama/prompts/fix.md", "Fix: $1");
    const runtime = await h.boot(["--model", "fake/echo"]);
    await runtime.session.prompt("/skill:review now");
    expect(runtime.session.getLastAssistantText()).toContain("Do a review.");
    await runtime.session.prompt("/fix bug");
    expect(runtime.session.getLastAssistantText()).toBe("Fix: bug");
    await expect(runtime.session.prompt("/skill:nope")).rejects.toMatchObject({
      code: "skill_not_found",
      message: expect.stringContaining("review"),
    });
    await runtime.dispose();
  });
});
