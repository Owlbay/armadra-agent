import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import {
  BUILTIN_SKILLS,
  BUILTIN_SKILLS_DIR,
  builtinSkillText,
  isBuiltinSkill,
  withBuiltinSkills,
} from "./builtin.js";
import { parseSkill, type Skill } from "./discover.js";
import { expandSkillCommand } from "./expand.js";

let home: TmpHome | undefined;
let h: ComposeHarness | undefined;
afterEach(() => {
  home?.cleanup();
  h?.cleanup();
  home = h = undefined;
});

describe("内置 Skill", () => {
  it("ama-docs 正文 2–3 KB，frontmatter 能按普通 SKILL.md 解析", () => {
    const docs = BUILTIN_SKILLS.find((s) => s.name === "ama-docs")!;
    expect(docs.body.length).toBeGreaterThan(2000);
    expect(docs.body.length).toBeLessThanOrEqual(3072);
    const parsed = parseSkill(builtinSkillText(docs), "/x/SKILL.md", "builtin");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.skill).toMatchObject({ name: "ama-docs", description: docs.description });
  });

  it("写到 <dataDir>/builtin/ama-docs.md，内容不变不重写；/skill:ama-docs 可展开", async () => {
    home = createTmpHome();
    const first = await withBuiltinSkills([], home.dataDir);
    const skill = first.skills.find((s) => s.name === "ama-docs")!;
    expect(skill.scope).toBe("builtin");
    expect(skill.location).toBe(join(home.dataDir, BUILTIN_SKILLS_DIR, "ama-docs.md"));
    expect(isBuiltinSkill(skill)).toBe(true);
    expect(isBuiltinSkill({ name: "ama-docs", location: "/u/ama-docs/SKILL.md" })).toBe(false);
    const mtime = statSync(skill.location).mtimeMs;
    const again = await withBuiltinSkills([], home.dataDir);
    expect(again.skills[0]!.location).toBe(skill.location);
    expect(statSync(skill.location).mtimeMs).toBe(mtime);
    writeFileSync(skill.location, "stale");
    await withBuiltinSkills([], home.dataDir);
    expect(readFileSync(skill.location, "utf8")).toBe(builtinSkillText(BUILTIN_SKILLS[0]!));
    const expanded = await expandSkillCommand("/skill:ama-docs providers", first.skills);
    expect(expanded?.kind === "expanded" && expanded.text).toContain("ama auth set");
  });

  it("同名时用户 / 项目的 Skill 优先，内置的静默让位", async () => {
    home = createTmpHome();
    const mine: Skill = {
      name: "ama-docs",
      description: "my own",
      location: "/u/ama-docs/SKILL.md",
      baseDir: "/u/ama-docs",
      disableModelInvocation: false,
      scope: "user",
    };
    const result = await withBuiltinSkills([mine], home.dataDir);
    expect(result.skills).toEqual([mine]);
    expect(result.warnings).toEqual([]);
  });

  it("写盘失败只记 warning 并跳过", async () => {
    home = createTmpHome();
    const blocker = home.write("blocker", "file");
    const result = await withBuiltinSkills([], join(blocker, "data"));
    expect(result.skills).toEqual([]);
    expect(result.warnings[0]).toContain("ama-docs");
  });

  it("组装后进系统提示的 skills 索引（排在用户 Skill 之后）", async () => {
    h = composeHarness();
    h.home.write(
      "home/.config/ama/skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\nbody\n",
    );
    const runtime = await h.boot(["--model", "fake/echo"]);
    await runtime.session.prompt("hi");
    const system = runtime.session.entries.flatMap((e) =>
      e.type === "message" && e.message.role === "system" ? [e.message] : [],
    )[0]!;
    const skills = String(system.sections["skills"]);
    expect(skills.indexOf('name="review"')).toBeLessThan(skills.indexOf('name="ama-docs"'));
    expect(skills).toContain(join(h.home.dataDir, BUILTIN_SKILLS_DIR, "ama-docs.md"));
    await runtime.dispose();
  });
});
