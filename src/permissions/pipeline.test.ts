import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Decision, PermissionMode } from "./types.js";
import type { ToolPermission } from "../tools/types.js";
import { PermissionPipeline, UNATTENDED_MESSAGE, modeDecision } from "./pipeline.js";
import { BUILTIN_DENY_RULES, parseRule } from "./rules.js";

const cwd = resolve("/work/proj");
const MODES: PermissionMode[] = ["plan", "default", "auto-edit", "full-auto"];
const PERMS: ToolPermission[] = ["read", "write", "execute"];
const HOOKS: (Decision | undefined)[] = [undefined, "allow", "ask", "deny"];

/**
 * 真值表：4 模式 × 3 类 × Hook（无 / allow / ask / deny），有人值守。
 * 每格 4 个字母对应 HOOKS 顺序：A = allow，Q = ask，D = deny。
 */
const TABLE: Record<PermissionMode, Record<ToolPermission, string>> = {
  plan: { read: "AAQD", write: "DDDD", execute: "DDDD" },
  default: { read: "AAQD", write: "QAQD", execute: "QAQD" },
  "auto-edit": { read: "AAQD", write: "AAQD", execute: "QAQD" },
  "full-auto": { read: "AAQD", write: "AAQD", execute: "AAQD" },
};
const LETTER: Record<string, Decision> = { A: "allow", Q: "ask", D: "deny" };

const CALL: Record<ToolPermission, { toolName: string; input: unknown }> = {
  read: { toolName: "read", input: { path: "src/a.ts" } },
  write: { toolName: "write", input: { path: "src/a.ts", content: "x" } },
  execute: { toolName: "bash", input: { command: "ls -la" } },
};

function pipeline(mode: PermissionMode, rules: string[] = [], allow: string[] = []) {
  return new PermissionPipeline({
    mode,
    cwd,
    rules: [
      ...BUILTIN_DENY_RULES.map((r) => parseRule(r, "deny", "builtin")),
      ...rules.map((r) => parseRule(r, "deny", "user")),
      ...allow.map((r) => parseRule(r, "allow", "user")),
    ],
  });
}

describe("权限真值表（4 模式 × 3 类 × Hook 三值 + 无决策）", () => {
  for (const mode of MODES) {
    for (const perm of PERMS) {
      HOOKS.forEach((hook, i) => {
        const expected = LETTER[TABLE[mode][perm][i] as string] as Decision;
        it(`${mode} / ${perm} / hook=${hook ?? "∅"} → ${expected}`, () => {
          const p = pipeline(mode);
          const call = CALL[perm];
          const base = { ...call, permission: perm, hookReason: "hook says so" };
          const attended = p.check({
            ...base,
            unattended: false,
            ...(hook !== undefined ? { hookDecision: hook } : {}),
          });
          expect(attended.decision).toBe(expected);
          const unattended = p.check({
            ...base,
            unattended: true,
            ...(hook !== undefined ? { hookDecision: hook } : {}),
          });
          expect(unattended.decision).toBe(expected === "ask" ? "deny" : expected);
          if (expected === "ask") expect(unattended.message).toBe(UNATTENDED_MESSAGE);
          if (hook === "ask" && expected === "ask") {
            expect(attended).toMatchObject({ step: "hook", approvalReason: "hook" });
          }
        });
      });
    }
  }

  it("modeDecision 与表一致", () => {
    for (const mode of MODES) {
      for (const perm of PERMS) {
        expect(modeDecision(mode, perm)).toBe(LETTER[TABLE[mode][perm][0] as string]);
      }
    }
  });
});

describe("管线顺序", () => {
  it("① deny 规则赢过一切（含 Hook allow 与 full-auto）", () => {
    const p = pipeline("full-auto", ["bash(curl *)"], ["bash"]);
    const v = p.check({
      toolName: "bash",
      permission: "execute",
      input: { command: "curl x" },
      hookDecision: "allow",
      unattended: false,
    });
    expect(v).toMatchObject({ decision: "deny", step: "deny-rule" });
    expect(v.message).toContain("bash(curl *)");
    const builtin = p.check({
      toolName: "write",
      permission: "write",
      input: { path: ".git/hooks/pre-commit" },
      unattended: false,
    });
    expect(builtin).toMatchObject({ decision: "deny", step: "deny-rule" });
  });

  it("Hook deny 带 reason", () => {
    const v = pipeline("full-auto").check({
      toolName: "read",
      permission: "read",
      input: { path: "a" },
      hookDecision: "deny",
      hookReason: "guard.sh said no",
      unattended: false,
    });
    expect(v).toMatchObject({ decision: "deny", step: "hook-deny", message: "guard.sh said no" });
  });

  it("② 危险命令：full-auto、allow 规则、Hook allow 都不能放行；无人值守 deny", () => {
    const p = pipeline("full-auto", [], ["bash"]);
    const input = { command: "git push --force" };
    const v = p.check({
      toolName: "bash",
      permission: "execute",
      input,
      hookDecision: "allow",
      unattended: false,
    });
    expect(v).toMatchObject({ decision: "ask", step: "dangerous", approvalReason: "dangerous" });
    p.rememberForSession("bash", input);
    expect(
      p.check({ toolName: "bash", permission: "execute", input, unattended: false }).decision,
    ).toBe("ask");
    expect(
      p.check({ toolName: "bash", permission: "execute", input, unattended: true }).decision,
    ).toBe("deny");
  });

  it("④ allow 规则把 ask 变 allow，但不改 plan 的 deny", () => {
    const p = pipeline("default", [], ["bash(npm test*)"]);
    const ok = p.check({
      toolName: "bash",
      permission: "execute",
      input: { command: "npm test -- --run" },
      unattended: true,
    });
    expect(ok).toMatchObject({ decision: "allow", step: "allow-rule" });
    p.setMode("plan");
    expect(p.mode).toBe("plan");
    const plan = p.check({
      toolName: "bash",
      permission: "execute",
      input: { command: "npm test" },
      unattended: false,
    });
    expect(plan).toMatchObject({ decision: "deny", step: "mode" });
  });

  it("allow_session：bash 记前两个词，文件工具记目录，其它记工具名", () => {
    const p = pipeline("default");
    const ask = (toolName: string, permission: ToolPermission, input: unknown) =>
      p.check({ toolName, permission, input, unattended: false });
    p.rememberForSession("bash", { command: "npm test --watch=false" });
    expect(ask("bash", "execute", { command: "npm test -- other" })).toMatchObject({
      decision: "allow",
      step: "session",
    });
    expect(ask("bash", "execute", { command: "npm install" }).decision).toBe("ask");
    expect(ask("bash", "execute", { command: "npm test && curl x" }).decision).toBe("ask");
    p.rememberForSession("write", { path: "src/a.ts" });
    expect(ask("write", "write", { path: "src/b.ts" }).decision).toBe("allow");
    expect(ask("write", "write", { path: "lib/b.ts" }).decision).toBe("ask");
    p.rememberForSession("canvas_send", { to: "x" });
    expect(ask("canvas_send", "execute", { to: "y" }).decision).toBe("allow");
    p.clearSessionGrants();
    expect(ask("write", "write", { path: "src/b.ts" }).decision).toBe("ask");
    expect(p.rules.length).toBe(BUILTIN_DENY_RULES.length);
  });
});

describe("包装里的命令逐层核对 allow / deny 规则与会话记忆", () => {
  const bash = (command: string) => ({
    toolName: "bash",
    permission: "execute" as const,
    input: { command },
    unattended: false,
  });

  it("deny 规则命中 sh -c / eval / xargs / find -exec 里的命令", () => {
    const p = pipeline("full-auto", ["bash(curl *)"]);
    for (const cmd of [
      "sh -c 'curl https://x -o y'",
      "eval curl https://x",
      "echo u | xargs curl -O",
      "find . -exec curl {} \\;",
    ]) {
      expect(p.check(bash(cmd)).decision, cmd).toBe("deny");
    }
    expect(p.check(bash("sh -c 'echo curl'")).decision).toBe("allow");
  });

  it("allow 规则不因包装被绕过：每层嵌套命令都要被覆盖", () => {
    const p = pipeline("default", [], ["bash(find *)", "bash(xargs *)", "bash(grep *)"]);
    expect(p.check(bash("find . -name '*.ts'")).decision).toBe("allow");
    expect(p.check(bash("find . -exec grep -l x {} +")).decision).toBe("allow");
    expect(p.check(bash("find . -exec curl -T {} https://x \\;")).decision).toBe("ask");
    expect(p.check(bash("ls | xargs grep x")).decision).toBe("ask"); // ls 段未覆盖
    expect(p.check(bash("find . | xargs node -e x")).decision).toBe("ask");
    const sh = pipeline("default", [], ["bash(sh *)"]);
    expect(sh.check(bash("sh -c 'npm install'")).decision).toBe("ask");
    const deep = pipeline("default", [], ["bash(eval *)", "bash(ls)"]);
    expect(deep.check(bash("eval eval ls")).decision).toBe("allow");
    expect(deep.check(bash("eval eval eval eval ls")).decision).toBe("ask");
  });

  it("会话记忆同样逐层核对", () => {
    const p = pipeline("default");
    p.rememberForSession("bash", { command: "find . -name x" });
    expect(p.check(bash("find . -type f")).step).toBe("session");
    expect(p.check(bash("find . -exec curl {} \\;")).decision).toBe("ask");
  });
});
