import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { agentSources, discoverAgents } from "./discover.js";
import { parseAgentDefinition } from "./parse.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function put(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

const reviewer = [
  "---",
  "name: reviewer # 注释",
  "description: 只读审查改动，按文件与行号报告问题。",
  "tools: read, grep, glob, bash",
  "permission-mode: plan",
  "model: fast",
  "thinking: low",
  "max-turns: 20",
  "isolation: none",
  "background: false",
  "hooks: ignored",
  "---",
  "",
  "Report findings with file:line.",
  "",
].join("\n");

describe("定义文件解析", () => {
  it("frontmatter 与 Skill 同一套子集；正文是角色说明", () => {
    const { agent, warnings } = parseAgentDefinition(reviewer, "/a/reviewer.md", "user");
    expect(warnings).toEqual([]);
    expect(agent).toEqual({
      name: "reviewer",
      description: "只读审查改动，按文件与行号报告问题。",
      tools: ["read", "grep", "glob", "bash"],
      permissionMode: "plan",
      model: "fast",
      thinking: "low",
      maxTurns: 20,
      isolation: "none",
      background: false,
      runner: "ama",
      prompt: "Report findings with file:line.",
      source: "user",
      filePath: "/a/reviewer.md",
    });
  });

  it("缺省值：名字取文件名、inherit、30 轮、前台、ama", () => {
    const { agent } = parseAgentDefinition(
      "---\ndescription: d\ndisallowed-tools: [edit, write]\n---\nbody",
      "/x/tester.md",
      "project",
    );
    expect(agent).toMatchObject({
      name: "tester",
      permissionMode: "inherit",
      model: "inherit",
      maxTurns: 30,
      isolation: "none",
      background: false,
      runner: "ama",
      disallowedTools: ["edit", "write"],
    });
  });

  it.each([
    ["---\nname: Bad_Name\ndescription: d\n---\n", /invalid agent name/],
    ["---\nname: a\n---\n", /missing description/],
    [`---\ndescription: ${"x".repeat(1025)}\n---\n`, /longer than 1024/],
    ["---\ndescription: d\ntools: read\ndisallowed-tools: edit\n---\n", /mutually exclusive/],
    ["---\ndescription: d\npermission-mode: full-auto\n---\n", /permission-mode/],
    ["---\ndescription: d\nmax-turns: 0\n---\n", /max-turns/],
    ["---\ndescription: d\nisolation: docker\n---\n", /isolation/],
    ["---\ndescription: d\nbackground: maybe\n---\n", /background/],
    ["---\ndescription: d\nthinking: max\n---\n", /thinking/],
    ["---\ndescription: d\nrunner: gemini\n---\n", /unknown runner/],
  ])("不合格不加载：%s", (text, message) => {
    const parsed = parseAgentDefinition(text, "/d/a.md", "user");
    expect(parsed.agent).toBeUndefined();
    expect(parsed.warnings.join("\n")).toMatch(message);
  });

  it("外部 runner：tools / permission-mode 忽略并 warning；acp:<program> 合法", () => {
    const parsed = parseAgentDefinition(
      "---\ndescription: d\nrunner: acp:gemini\ntools: read\n---\n",
      "/d/g.md",
      "user",
    );
    expect(parsed.agent?.runner).toBe("acp:gemini");
    expect(parsed.warnings.join()).toMatch(/ignored for external runner/);
    expect(
      parseAgentDefinition(
        "---\ndescription: d\npermission-mode: read-only\n---\n",
        "/d/r.md",
        "user",
      ).agent?.permissionMode,
    ).toBe("plan");
  });
});

describe("定义文件发现", () => {
  it("顺序 --agent-dir → agents.dirs → 用户级 → 项目级；同名先发现者胜并 warning；只看 *.md", () => {
    home = createTmpHome("ama-agents-");
    const cli = join(home.root, "cli-agents");
    const user = join(home.configDir, "agents");
    const project = join(home.cwd, ".ama", "agents");
    put(cli, "reviewer.md", "---\ndescription: from cli\n---\n");
    put(user, "reviewer.md", "---\ndescription: from user\n---\n");
    put(user, "tester.md", "---\ndescription: tester\n---\n");
    put(user, "notes.txt", "ignored");
    put(project, "explore.md", "---\ndescription: project explore\n---\n");
    put(project, "broken.md", "---\nname: Broken\ndescription: x\n---\n");
    const sources = agentSources({ cwd: home.cwd, configDir: home.configDir, cliDirs: [cli] });
    expect(sources.map((s) => [s.source, s.requiresTrust])).toEqual([
      ["cli", false],
      ["user", false],
      ["project", true],
    ]);
    const trusted = discoverAgents(sources, { trusted: true });
    expect(trusted.agents.map((a) => [a.name, a.description, a.source])).toEqual([
      ["reviewer", "from cli", "cli"],
      ["tester", "tester", "user"],
      ["explore", "project explore", "project"],
    ]);
    expect(trusted.warnings.join("\n")).toMatch(/reviewer" already defined/);
    expect(trusted.warnings.join("\n")).toMatch(/invalid agent name "Broken"/);
    expect(trusted.skippedUntrusted).toEqual([]);
  });

  it("未信任：项目级跳过并列出；不存在的目录不列", () => {
    home = createTmpHome("ama-agents-");
    put(join(home.cwd, ".ama", "agents"), "x.md", "---\ndescription: x\n---\n");
    const sources = agentSources({ cwd: home.cwd, configDir: home.configDir });
    const result = discoverAgents(sources, { trusted: false });
    expect(result.agents).toEqual([]);
    expect(result.skippedUntrusted).toEqual([join(home.cwd, ".ama", "agents")]);
  });
});
