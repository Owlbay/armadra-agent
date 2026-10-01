import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverPromptTemplates,
  expandPromptCommand,
  expandTemplate,
  parseCommandArgs,
  parsePromptCommand,
  promptSources,
} from "./templates.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, "../../test/fixtures/skills");
const portable = (text: string) => text.split(FIX).join("<root>").replace(/\\/g, "/");

describe("参数切分", () => {
  it("shell 规则", () => {
    expect(parseCommandArgs(`a "b c" 'd e' f\\ g "x\\"y" ''`)).toEqual([
      "a",
      "b c",
      "d e",
      "f g",
      'x"y',
      "",
    ]);
    expect(parseCommandArgs("   ")).toEqual([]);
  });
});

describe("模板展开", () => {
  const args = ["one", "two", "three"];
  it.each([
    ["$1 and $2", "one and two"],
    ["all: $@", "all: one two three"],
    ["all: $ARGUMENTS", "all: one two three"],
    ["${1}", "one"],
    ["${4:-dflt}", "dflt"],
    ["${1:-dflt}", "one"],
    ["${@:2}", "two three"],
    ["${@:2:1}", "two"],
    ["${@:-none}", "one two three"],
    ["$9|", "|"],
    ["cost \\$5 for $1", "cost $5 for one"],
  ])("%s", (template, expected) => {
    expect(expandTemplate(template, args)).toBe(expected);
  });

  it("${@:-默认} 在无参数时取默认；无占位时参数接在正文后", () => {
    expect(expandTemplate("x ${@:-none}", [])).toBe("x none");
    expect(expandTemplate("Summarize.\n", ["focus", "tests"])).toBe("Summarize.\n\nfocus tests");
    expect(expandTemplate("Summarize.\n", [])).toBe("Summarize.\n");
  });
});

describe("模板发现与 /cmd", () => {
  const sources = () => promptSources({ cwd: join(FIX, "work"), configDir: join(FIX, "config") });

  it("未信任跳过项目级；用户级先于项目级", async () => {
    const r = await discoverPromptTemplates(sources(), { trusted: false });
    expect(r.templates.map((t) => [t.name, t.scope, t.description, t.argumentHint])).toEqual([
      ["fix", "user", "Fix an issue", "<issue> [area]"],
      ["plain", "user", "Summarize the repository.", undefined],
    ]);
    expect(r.skippedUntrusted.map(portable)).toEqual(["<root>/work/.ama/prompts"]);
    const trusted = await discoverPromptTemplates(sources(), { trusted: true });
    expect(trusted.templates.map((t) => t.name)).toEqual(["fix", "plain", "ship"]);
    expect(portable(trusted.warnings.join("\n"))).toContain(
      'prompt "/fix" already defined at <root>/config/prompts/fix.md',
    );
  });

  it("展开 /fix 与 /ship；非模板命令返回 undefined", async () => {
    const { templates } = await discoverPromptTemplates(sources(), { trusted: true });
    const fix = await expandPromptCommand('/fix 42 "auth module"', templates);
    expect(fix?.text).toBe("Fix issue 42 in auth module. All: 42 auth module\n");
    const fixDefault = await expandPromptCommand("/fix 7", templates);
    expect(fixDefault?.text).toBe("Fix issue 7 in the whole repo. All: 7\n");
    const ship = await expandPromptCommand("/ship prod a b", templates);
    expect(ship?.text).toBe("Ship a b to prod\n");
    expect(await expandPromptCommand("/model x", templates)).toBeUndefined();
    expect(parsePromptCommand("not a command")).toBeUndefined();
  });
});
