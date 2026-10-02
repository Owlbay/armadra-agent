/**
 * 权限类 `memory`（docs/wave6-plan.md §3.3、D10；[W6-C0]）：view 放行，写命令按 execute 判定。
 */

import { describe, expect, it } from "vitest";
import { memoryCommand, memoryEffectivePermission, memoryRuleMatches } from "./memory-class.js";
import { PermissionPipeline } from "./pipeline.js";
import { parseRule } from "./rules.js";
import type { PermissionMode } from "./types.js";

const cwd = "/work";

function check(mode: PermissionMode, command: string, allow: string[] = [], unattended = false) {
  const p = new PermissionPipeline({
    mode,
    cwd,
    rules: allow.map((r) => parseRule(r, "allow", "user")),
  });
  return p.check({
    toolName: "memory",
    permission: "memory",
    input: { command, path: "/memories/user/a.md" },
    unattended,
  }).decision;
}

describe("memory 权限类", () => {
  it("按 command 折成 read / execute", () => {
    expect(memoryCommand({ command: "view" })).toBe("view");
    expect(memoryCommand("x")).toBeUndefined();
    expect(memoryEffectivePermission({ command: "view" })).toBe("read");
    for (const c of ["create", "str_replace", "delete", "unknown"])
      expect(memoryEffectivePermission({ command: c })).toBe("execute");
    expect(memoryEffectivePermission({})).toBe("execute");
  });

  it("真值表：view 各模式放行；写命令 default / auto-edit 询问、plan 拒绝、full-auto 放行、allowlist 拒绝", () => {
    const modes: PermissionMode[] = ["default", "auto-edit", "plan", "full-auto", "allowlist"];
    expect(modes.map((m) => check(m, "view"))).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
    ]);
    expect(modes.map((m) => check(m, "create"))).toEqual(["ask", "ask", "deny", "allow", "deny"]);
  });

  it("无人值守时写命令询问 → 拒绝；allow 规则 memory 放行", () => {
    expect(check("default", "create", [], true)).toBe("deny");
    expect(check("default", "create", ["memory"])).toBe("allow");
    expect(check("allowlist", "delete", ["memory"])).toBe("allow");
  });

  it("本会话允许后不再询问", () => {
    const p = new PermissionPipeline({ mode: "default", cwd, rules: [] });
    const input = { command: "create", path: "/memories/user/a.md", file_text: "x" };
    const req = { toolName: "memory", permission: "memory" as const, input, unattended: false };
    expect(p.check(req).decision).toBe("ask");
    p.rememberForSession("memory", input);
    expect(p.check(req).decision).toBe("allow");
  });

  it("[W6-M] memory(pattern)：命令名、逻辑路径 glob、* 全部；不按 bash 命令或真实路径匹配", () => {
    const input = { command: "create", path: "/memories/user/a.md" };
    expect(memoryRuleMatches("*", input)).toBe(true);
    expect(memoryRuleMatches("**", input)).toBe(true);
    expect(memoryRuleMatches("create", input)).toBe(true);
    expect(memoryRuleMatches("delete", input)).toBe(false);
    expect(memoryRuleMatches("/memories/user/**", input)).toBe(true);
    expect(memoryRuleMatches("/memories/user/*.md", input)).toBe(true);
    expect(memoryRuleMatches("/memories/project/**", input)).toBe(false);
    expect(memoryRuleMatches("/memories/*", input)).toBe(false);
    expect(memoryRuleMatches("/memories/user/**", { command: "view" })).toBe(false);
    expect(check("default", "create", ["memory(*)"])).toBe("allow");
    expect(check("default", "create", ["memory(create)"])).toBe("allow");
    expect(check("default", "delete", ["memory(create)"])).toBe("ask");
    expect(check("default", "create", ["memory(/memories/user/**)"])).toBe("allow");
    expect(check("default", "create", ["memory(/memories/project/**)"])).toBe("ask");
    expect(check("allowlist", "str_replace", ["memory(*)"])).toBe("allow");
  });

  it("[W6-M] deny 规则按逻辑路径命中，压过 full-auto", () => {
    const p = new PermissionPipeline({
      mode: "full-auto",
      cwd,
      rules: [parseRule("memory(/memories/user/**)", "deny", "user")],
    });
    const at = (path: string) =>
      p.check({
        toolName: "memory",
        permission: "memory",
        input: { command: "create", path },
        unattended: false,
      }).decision;
    expect(at("/memories/user/a.md")).toBe("deny");
    expect(at("/memories/project/a.md")).toBe("allow");
  });

  it("[W6-M] 本会话允许一次，覆盖全部写命令（不限 create）", () => {
    const p = new PermissionPipeline({ mode: "default", cwd, rules: [] });
    p.rememberForSession("memory", { command: "create", path: "/memories/user/a.md" });
    for (const command of ["str_replace", "delete", "create"])
      expect(
        p.check({
          toolName: "memory",
          permission: "memory",
          input: { command, path: "/memories/project/b.md" },
          unattended: false,
        }).decision,
      ).toBe("allow");
  });
});
