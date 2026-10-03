import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.js";
import { isSearchCommand, searchToolsHint } from "./search-hint.js";

afterEach(() => setLocale("zh"));

const MINIMAL = ["bash", "edit", "read", "write"];

describe("[S-A] -p 搜索命令被拒的提示", () => {
  it("命令位置上的 grep / rg / find 等算搜索；参数或字符串里出现不算", () => {
    for (const command of [
      "grep -rn process.env .",
      "rg TODO src",
      "find . -name '*.ts'",
      "cd src && grep -l foo *.js",
      "cat a | /usr/bin/grep x",
      "LC_ALL=C egrep -r x .",
      "sudo find / -name x",
      "echo $(fd config)",
    ]) {
      expect(isSearchCommand(command), command).toBe(true);
    }
    for (const command of [
      "ls -la",
      "echo grep",
      "git grep x",
      "npm run find-deps",
      "cat grep.ts",
    ]) {
      expect(isSearchCommand(command), command).toBe(false);
    }
  });

  it("只在 minimal / coordinator、活动集缺 grep 或 glob、且被拒命令形如搜索时给（zh / en）", () => {
    expect(searchToolsHint(["grep -rn x ."], "minimal", MINIMAL)).toBe(
      'ama: minimal 预设没有 grep / glob，可用 tools.default: ["+grep","+glob"] 加上',
    );
    expect(searchToolsHint(["rg x"], "minimal", [...MINIMAL, "grep"])).toBe(
      'ama: minimal 预设没有 glob，可用 tools.default: ["+glob"] 加上',
    );
    setLocale("en");
    expect(searchToolsHint(["find . -name x"], "coordinator", ["read"])).toBe(
      'ama: the coordinator preset has no grep / glob; add them with tools.default: ["+grep","+glob"]',
    );
    expect(searchToolsHint(["rg x"], "minimal", [...MINIMAL, "glob"])).toBe(
      'ama: the minimal preset has no grep; add it with tools.default: ["+grep"]',
    );
    expect(searchToolsHint(["ls"], "minimal", MINIMAL)).toBeUndefined();
    expect(searchToolsHint([], "minimal", MINIMAL)).toBeUndefined();
    expect(searchToolsHint(["grep x"], "minimal", [...MINIMAL, "glob", "grep"])).toBeUndefined();
    expect(searchToolsHint(["grep x"], "default", MINIMAL)).toBeUndefined();
    expect(searchToolsHint(["grep x"], "codemode-only", ["codemode"])).toBeUndefined();
  });
});
