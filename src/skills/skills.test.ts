import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, parseScalar } from "./frontmatter.js";
import { ancestorDirs, discoverSkills, parseSkill, skillSources, type Skill } from "./discover.js";
import { formatSkillIndex } from "./index-prompt.js";
import { expandSkillCommand, formatSkillInvocation, parseSkillCommand } from "./expand.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, "../../test/fixtures/skills");
const GOLDEN = join(FIX, "index.golden.txt");

function sources(extra: { cli?: boolean } = {}) {
  return skillSources({
    cwd: join(FIX, "work"),
    configDir: join(FIX, "config"),
    ...(extra.cli === false ? {} : { cliDirs: [join(FIX, "cli")] }),
  });
}

/** 把 fixture 根换成 `<root>`，换行统一。 */
const portable = (text: string) => text.split(FIX).join("<root>").replace(/\\/g, "/");

describe("frontmatter 子集", () => {
  it("标量、引号、注释、行内与块数组", () => {
    const fm = parseFrontmatter(
      [
        "---",
        "name: x # 注释",
        'title: "a # not comment"',
        "single: 'it''s'",
        "n: 42",
        "f: 1.5",
        "yes: true",
        "nothing: ~",
        "tags: [a, 'b c', 3]",
        "list:",
        "  - one",
        "  - two",
        "empty:",
        "---",
        "body line",
      ].join("\n"),
    );
    expect(fm.hasFrontmatter).toBe(true);
    expect(fm.errors).toEqual([]);
    expect(fm.data).toEqual({
      name: "x",
      title: "a # not comment",
      single: "it's",
      n: 42,
      f: 1.5,
      yes: true,
      nothing: null,
      tags: ["a", "b c", 3],
      list: ["one", "two"],
      empty: null,
    });
    expect(fm.body).toBe("body line");
  });

  it("不支持的写法记错误；无头时全文是正文", () => {
    const fm = parseFrontmatter("---\nd: |\n  multi\nm: {a: 1}\nbad line\n---\n");
    expect(fm.errors).toHaveLength(4);
    expect(parseFrontmatter("no header").hasFrontmatter).toBe(false);
    expect(parseFrontmatter("---\nunterminated").body).toBe("---\nunterminated");
    expect(parseScalar('"esc\\n"')).toBe("esc\n");
  });
});

describe("Skill 发现", () => {
  it("顺序：cli → config → 项目（需信任）→ 祖先 .agents（需信任）", () => {
    const s = sources();
    expect(s.slice(0, 4).map((x) => [portable(x.dir), x.scope, x.requiresTrust])).toEqual([
      ["<root>/cli", "cli", false],
      ["<root>/config/skills", "user", false],
      ["<root>/work/.ama/skills", "project", true],
      ["<root>/work/.agents/skills", "ancestor", true],
    ]);
    expect(s.slice(3).every((x) => x.scope === "ancestor")).toBe(true);
    expect(ancestorDirs(join(FIX, "work"))[0]).toBe(join(FIX, "work"));
  });

  it("未信任：跳过项目与祖先来源；重名保留先发现者；不合格的记 warning", async () => {
    const r = await discoverSkills(sources(), { trusted: false });
    expect(r.skills.map((s) => [s.name, s.scope])).toEqual([
      ["review", "cli"],
      ["lint", "user"],
      ["hidden", "user"],
    ]);
    expect(r.skippedUntrusted.map(portable)).toEqual([
      "<root>/work/.ama/skills",
      "<root>/work/.agents/skills",
    ]);
    const warnings = r.warnings.map(portable).join("\n");
    expect(warnings).toContain('invalid skill name "Bad_Name"');
    expect(warnings).toContain('missing description; skill "nodesc" not loaded');
    expect(warnings).toContain('skill "review" already defined at <root>/cli/review/SKILL.md');
    expect(warnings).not.toContain("nested-should-not-load");
    const lint = r.skills.find((s) => s.name === "lint") as Skill;
    expect(lint.allowedTools).toEqual(["read", "edit", "bash"]);
    expect(lint.description).toBe('Lint <files> & fix "style" issues');
    expect(r.skills.find((s) => s.name === "hidden")?.disableModelInvocation).toBe(true);
  });

  it("已信任：加载项目与祖先技能", async () => {
    const r = await discoverSkills(sources(), { trusted: true });
    expect(r.skills.map((s) => s.name)).toEqual(["review", "lint", "hidden", "proj-helper", "anc"]);
    expect(r.skippedUntrusted).toEqual([]);
  });

  it("索引与黄金文件一致", async () => {
    const r = await discoverSkills(sources(), { trusted: true });
    const index = portable(formatSkillIndex(r.skills, { hasSkillTool: true, hasReadTool: true }));
    if (process.env["AMA_UPDATE_GOLDEN"] === "1") {
      writeFileSync(GOLDEN, `${index}\n`);
    }
    expect(`${index}\n`).toBe(readFileSync(GOLDEN, "utf8").replace(/\r\n/g, "\n"));
    expect(index).not.toContain("hidden");
  });

  it("索引：只有 read 工具时改用 read 的说法；都没有则为空", () => {
    const skills = [
      { name: "a", description: "d", location: "/x/SKILL.md", disableModelInvocation: false },
    ];
    expect(formatSkillIndex(skills, { hasSkillTool: false, hasReadTool: true })).toContain(
      "read its file",
    );
    expect(formatSkillIndex(skills, { hasSkillTool: false, hasReadTool: false })).toBe("");
    expect(formatSkillIndex([], { hasSkillTool: true, hasReadTool: true })).toBe("");
  });

  it("parseSkill：名字长度与描述长度", () => {
    expect(
      parseSkill(`---\nname: ${"a".repeat(65)}\ndescription: x\n---\n`, "/s/SKILL.md", "user")
        .skill,
    ).toBeUndefined();
    expect(
      parseSkill(`---\ndescription: ${"d".repeat(1025)}\n---\n`, "/s/ok/SKILL.md", "user").skill,
    ).toBeUndefined();
    expect(parseSkill("---\ndescription: fine\n---\n", "/s/ok/SKILL.md", "user").skill?.name).toBe(
      "ok",
    );
  });
});

describe("/skill: 展开", () => {
  it("解析命令", () => {
    expect(parseSkillCommand("/skill:review  focus on auth\nand more")).toEqual({
      name: "review",
      args: "focus on auth\nand more",
    });
    expect(parseSkillCommand("/skill:review")).toEqual({ name: "review", args: "" });
    expect(parseSkillCommand("/review")).toBeUndefined();
  });

  it("展开格式（含 / 不含参数），未知技能列出可用名", async () => {
    const { skills } = await discoverSkills(sources(), { trusted: false });
    const r = await expandSkillCommand("/skill:review check auth", skills);
    expect(r?.kind).toBe("expanded");
    expect(portable(r?.kind === "expanded" ? r.text : "")).toBe(
      '<skill name="review" location="<root>/cli/review/SKILL.md">\n' +
        "References are relative to <root>/cli/review.\n\n" +
        "# Review\n\nRead the diff, then check `checklist.md` in this directory.\n" +
        "</skill>\n\ncheck auth",
    );
    const hidden = await expandSkillCommand("/skill:hidden", skills);
    expect(hidden?.kind).toBe("expanded");
    const unknown = await expandSkillCommand("/skill:nope", skills);
    expect(unknown).toEqual({
      kind: "unknown",
      name: "nope",
      available: ["review", "lint", "hidden"],
    });
    expect(await expandSkillCommand("hello", skills)).toBeUndefined();
    expect(formatSkillInvocation({ name: "a", location: "/l", baseDir: "/" }, "B", "")).toBe(
      '<skill name="a" location="/l">\nReferences are relative to /.\n\nB\n</skill>',
    );
  });
});
