import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAmaError } from "../errors.js";
import {
  BUILTIN_DENY_RULES,
  findAllowRule,
  findDenyRule,
  hasCommandSubstitution,
  parseRule,
  pathMatches,
  resolvePermissionLayers,
  splitShellSegments,
  toolNameMatches,
  wildcardToRegExp,
} from "./rules.js";

const cwd = resolve("/work/proj");

describe("规则语法", () => {
  it("解析 tool 与 tool(pattern)", () => {
    expect(parseRule("bash(git push*)", "deny", "user")).toEqual({
      effect: "deny",
      tool: "bash",
      pattern: "git push*",
      source: "user",
      raw: "bash(git push*)",
    });
    expect(parseRule(" canvas_* ", "allow", "cli")).toEqual({
      effect: "allow",
      tool: "canvas_*",
      source: "cli",
      raw: "canvas_*",
    });
    for (const bad of ["", "bash(", "bash()", "has space", "a(b"]) {
      try {
        parseRule(bad, "allow", "user");
        expect.unreachable(bad);
      } catch (err) {
        expect(isAmaError(err) && err.code).toBe("invalid_arguments");
      }
    }
  });

  it("通配与工具名 glob", () => {
    expect(wildcardToRegExp("git push*").test("git push --force origin")).toBe(true);
    expect(wildcardToRegExp("git push*").test("git pull")).toBe(false);
    expect(wildcardToRegExp("a?c").test("abc")).toBe(true);
    expect(toolNameMatches("canvas_*", "canvas_send")).toBe(true);
    expect(toolNameMatches("canvas_*", "bash")).toBe(false);
    expect(toolNameMatches("*", "anything")).toBe(true);
  });

  it("命令切段（引号内不切，重定向的 & 不切）与替换检测", () => {
    expect(splitShellSegments(`a && b || c; d | e & f\ng`)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
    expect(splitShellSegments(`echo "a && b" 'c;d'`)).toEqual([`echo "a && b" 'c;d'`]);
    expect(splitShellSegments("make 2>&1 | tee log")).toEqual(["make 2>&1", "tee log"]);
    expect(hasCommandSubstitution("echo $(id)")).toBe(true);
    expect(hasCommandSubstitution("echo `id`")).toBe(true);
    expect(hasCommandSubstitution("echo $HOME")).toBe(false);
  });

  it("路径匹配：相对 cwd、** 也匹配绝对、绝对与 ~", () => {
    expect(pathMatches("src/**", join(cwd, "src/a/b.ts"), cwd)).toBe(true);
    expect(pathMatches("src/**", join(cwd, "lib/a.ts"), cwd)).toBe(false);
    expect(pathMatches("**/.git/**", join(cwd, ".git/config"), cwd)).toBe(true);
    expect(pathMatches("**/.ssh/**", join(homedir(), ".ssh/id_rsa"), cwd)).toBe(true);
    expect(pathMatches("**/.env*", join(cwd, "app/.env.local"), cwd)).toBe(true);
    expect(pathMatches("~/.aws/**", join(homedir(), ".aws/credentials"), cwd)).toBe(true);
    expect(pathMatches("/etc/**", resolve("/etc/hosts"), cwd)).toBe(true);
    expect(pathMatches("src/**", resolve("/elsewhere/src/x"), cwd)).toBe(false);
    expect(pathMatches("**", cwd, cwd)).toBe(true);
  });
});

describe("规则命中", () => {
  const rules = [
    ...BUILTIN_DENY_RULES.map((r) => parseRule(r, "deny", "builtin")),
    parseRule("bash(rm *)", "deny", "user"),
    parseRule("bash(git status*)", "allow", "user"),
    parseRule("bash(npm test*)", "allow", "user"),
    parseRule("write(src/**)", "allow", "user"),
    parseRule("canvas_*", "allow", "profile"),
  ];

  it("deny：整条或任一段命中", () => {
    expect(findDenyRule(rules, "bash", { command: "rm -rf x" }, cwd)?.raw).toBe("bash(rm *)");
    expect(findDenyRule(rules, "bash", { command: "ls && rm x" }, cwd)?.raw).toBe("bash(rm *)");
    expect(findDenyRule(rules, "bash", { command: "ls" }, cwd)).toBeUndefined();
    expect(findDenyRule(rules, "write", { path: ".git/config" }, cwd)?.raw).toBe(
      "write(**/.git/**)",
    );
    expect(findDenyRule(rules, "read", { path: "~/.ssh/id_ed25519" }, cwd)?.source).toBe("builtin");
    expect(findDenyRule(rules, "read", { path: "src/a.ts" }, cwd)).toBeUndefined();
  });

  it("allow：每段都要被覆盖，命令替换不放行", () => {
    expect(findAllowRule(rules, "bash", { command: "git status -s" }, cwd)?.raw).toBe(
      "bash(git status*)",
    );
    expect(findAllowRule(rules, "bash", { command: "git status && npm test" }, cwd)).toBeDefined();
    expect(findAllowRule(rules, "bash", { command: "git status && curl x" }, cwd)).toBeUndefined();
    expect(findAllowRule(rules, "bash", { command: "git status $(curl x)" }, cwd)).toBeUndefined();
    expect(findAllowRule(rules, "write", { path: "src/x.ts" }, cwd)?.raw).toBe("write(src/**)");
    expect(findAllowRule(rules, "write", { path: "x.ts" }, cwd)).toBeUndefined();
    expect(findAllowRule(rules, "canvas_send", { to: "a" }, cwd)?.raw).toBe("canvas_*");
    const unconditional = [parseRule("bash", "allow", "cli")];
    expect(findAllowRule(unconditional, "bash", { command: "a $(b)" }, cwd)).toBeDefined();
  });
});

describe("来源合并：项目级只能收紧", () => {
  it("项目级 allow 与放宽 mode 被忽略并 warning；deny 与收紧生效", () => {
    const r = resolvePermissionLayers([
      { source: "user", mode: "auto-edit", allow: ["bash(git *)"], deny: ["write(**/.env*)"] },
      { source: "project", mode: "full-auto", allow: ["bash"], deny: ["bash(curl *)"] },
    ]);
    expect(r.mode).toBe("auto-edit");
    expect(r.rules.filter((x) => x.effect === "allow").map((x) => x.raw)).toEqual(["bash(git *)"]);
    expect(r.rules.some((x) => x.raw === "bash(curl *)" && x.source === "project")).toBe(true);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join("\n")).toMatch(/cannot relax permission mode/);
    expect(r.warnings.join("\n")).toMatch(/cannot add allow rule "bash"/);

    const tighter = resolvePermissionLayers([
      { source: "user", mode: "auto-edit" },
      { source: "project", mode: "plan" },
    ]);
    expect(tighter.mode).toBe("plan");
    expect(tighter.warnings).toEqual([]);
  });

  it("命令行在项目级之后仍可放宽", () => {
    const r = resolvePermissionLayers([
      { source: "project", mode: "plan" },
      { source: "cli", mode: "full-auto", allow: ["bash"] },
    ]);
    expect(r.mode).toBe("full-auto");
    expect(r.rules.some((x) => x.source === "cli" && x.effect === "allow")).toBe(true);
  });

  it("内置 deny 表可整体或逐条移除；坏规则记 warning", () => {
    expect(resolvePermissionLayers([]).rules).toHaveLength(BUILTIN_DENY_RULES.length);
    expect(resolvePermissionLayers([], { builtinDeny: false }).rules).toHaveLength(0);
    const partial = resolvePermissionLayers([], { builtinDeny: ["read(**/.ssh/**)"] });
    expect(partial.rules.map((r) => r.raw)).not.toContain("read(**/.ssh/**)");
    const bad = resolvePermissionLayers([{ source: "user", deny: ["bash("] }]);
    expect(bad.warnings[0]).toMatch(/Invalid permission rule/);
  });
});
