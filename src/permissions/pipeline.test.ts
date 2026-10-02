import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Decision, PermissionCheckInput, PermissionMode } from "./types.js";
import type { ToolPermission } from "../tools/types.js";
import { PermissionPipeline, UNATTENDED_MESSAGE, modeDecision } from "./pipeline.js";
import { BUILTIN_DENY_RULES, parseRule } from "./rules.js";

const cwd = resolve("/work/proj");
const MODES: PermissionMode[] = ["plan", "allowlist", "default", "auto-edit", "auto", "full-auto"];
const HOOKS: (Decision | undefined)[] = [undefined, "allow", "ask", "deny"];

type CallKind =
  | "read"
  | "readSecret"
  | "writeIn"
  | "writeOut"
  | "writeProtected"
  | "bashSafe"
  | "bashDangerous"
  | "bashNetwork"
  | "bashUnknown";

const CALL: Record<CallKind, { toolName: string; permission: ToolPermission; input: unknown }> = {
  read: { toolName: "read", permission: "read", input: { path: "src/a.ts" } },
  readSecret: { toolName: "read", permission: "read", input: { path: ".env" } },
  writeIn: { toolName: "write", permission: "write", input: { path: "src/a.ts", content: "x" } },
  writeOut: { toolName: "write", permission: "write", input: { path: "/tmp/x.txt", content: "x" } },
  writeProtected: {
    toolName: "edit",
    permission: "write",
    input: { path: ".ama/hooks.json", edits: [] },
  },
  bashSafe: { toolName: "bash", permission: "execute", input: { command: "ls -la" } },
  bashDangerous: {
    toolName: "bash",
    permission: "execute",
    input: { command: "git push --force" },
  },
  bashNetwork: {
    toolName: "bash",
    permission: "execute",
    input: { command: "curl https://example.com" },
  },
  bashUnknown: {
    toolName: "bash",
    permission: "execute",
    input: { command: "node scripts/gen.js" },
  },
};

/**
 * 真值表：6 模式 × 9 类调用 × Hook（无 / allow / ask / deny），有人值守。
 * 每格 4 个字母对应 HOOKS 顺序：A = allow，Q = ask，D = deny，C = ask 且交给分类器（auto）。
 * 无人值守时 Q / C → deny（C 仍带 classify，分类器 allow 可放行）。
 */
const TABLE: Record<PermissionMode, Record<CallKind, string>> = {
  plan: {
    read: "AAQD",
    readSecret: "AAQD",
    writeIn: "DDDD",
    writeOut: "DDDD",
    writeProtected: "DDDD",
    bashSafe: "DDDD",
    bashDangerous: "QQQD",
    bashNetwork: "DDDD",
    bashUnknown: "DDDD",
  },
  allowlist: {
    read: "AADD",
    readSecret: "AADD",
    writeIn: "DADD",
    writeOut: "DADD",
    writeProtected: "DADD",
    bashSafe: "DADD",
    bashDangerous: "DDDD",
    bashNetwork: "DADD",
    bashUnknown: "DADD",
  },
  default: {
    read: "AAQD",
    readSecret: "AAQD",
    writeIn: "QAQD",
    writeOut: "QAQD",
    writeProtected: "QAQD",
    bashSafe: "QAQD",
    bashDangerous: "QQQD",
    bashNetwork: "QAQD",
    bashUnknown: "QAQD",
  },
  "auto-edit": {
    read: "AAQD",
    readSecret: "AAQD",
    writeIn: "AAQD",
    writeOut: "AAQD",
    writeProtected: "AAQD",
    bashSafe: "QAQD",
    bashDangerous: "QQQD",
    bashNetwork: "QAQD",
    bashUnknown: "QAQD",
  },
  auto: {
    read: "AAQD",
    readSecret: "QQQD",
    writeIn: "AAQD",
    writeOut: "QQQD",
    writeProtected: "QQQD",
    bashSafe: "AAQD",
    bashDangerous: "QQQD",
    bashNetwork: "QQQD",
    bashUnknown: "CAQD",
  },
  "full-auto": {
    read: "AAQD",
    readSecret: "AAQD",
    writeIn: "AAQD",
    writeOut: "AAQD",
    writeProtected: "AAQD",
    bashSafe: "AAQD",
    bashDangerous: "QQQD",
    bashNetwork: "AAQD",
    bashUnknown: "AAQD",
  },
};
const LETTER: Record<string, Decision> = { A: "allow", Q: "ask", C: "ask", D: "deny" };

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

describe("权限真值表（6 模式 × 读 / 写 / bash × Hook 三值 + 无决策 × 有人 / 无人值守）", () => {
  for (const mode of MODES) {
    for (const kind of Object.keys(CALL) as CallKind[]) {
      HOOKS.forEach((hook, i) => {
        const letter = TABLE[mode][kind][i] as string;
        const expected = LETTER[letter] as Decision;
        it(`${mode} / ${kind} / hook=${hook ?? "∅"} → ${letter}`, () => {
          const p = pipeline(mode);
          const base = { ...CALL[kind], hookReason: "hook says so" };
          const withHook = hook !== undefined ? { hookDecision: hook } : {};
          const attended = p.check({ ...base, unattended: false, ...withHook });
          expect(attended.decision).toBe(expected);
          expect(attended.classify === true).toBe(letter === "C");
          if (mode === "auto") expect(attended.auto?.decision).toBe(expected);
          else expect(attended.auto).toBeUndefined();
          const unattended = p.check({ ...base, unattended: true, ...withHook });
          expect(unattended.decision).toBe(expected === "ask" ? "deny" : expected);
          expect(unattended.classify === true).toBe(letter === "C");
          if (expected === "ask") expect(unattended.message).toBe(UNATTENDED_MESSAGE);
          const without = TABLE[mode][kind][0] as string;
          if (hook === "ask" && expected === "ask" && (without === "A" || without === "C")) {
            expect(attended).toMatchObject({ approvalReason: "hook" });
          }
        });
      });
    }
  }

  it("modeDecision 与表的无 Hook 一列一致（auto 的 write / execute 在这一步是 ask）", () => {
    const permOf: Record<ToolPermission, CallKind> = {
      read: "read",
      write: "writeIn",
      execute: "bashUnknown",
    };
    for (const mode of MODES) {
      for (const perm of ["read", "write", "execute"] as ToolPermission[]) {
        const letter = TABLE[mode][permOf[perm]][0] as string;
        const expected = mode === "auto" && perm !== "read" ? "ask" : LETTER[letter];
        expect(modeDecision(mode, perm), `${mode}/${perm}`).toBe(expected);
      }
    }
  });
});

describe("auto 三层", () => {
  const bash = (command: string, extra: Partial<PermissionCheckInput> = {}) => ({
    toolName: "bash",
    permission: "execute" as const,
    input: { command },
    unattended: false,
    ...extra,
  });

  it("每个结论带 layer 与 reason", () => {
    const p = pipeline("auto", ["bash(terraform *)"]);
    expect(p.check(bash("npm test")).auto).toMatchObject({ layer: "static", decision: "allow" });
    expect(p.check(bash("rm -rf ./build")).auto).toMatchObject({
      layer: "rule",
      decision: "ask",
      reason: "recursive or forced rm",
    });
    expect(p.check(bash("npm install left-pad")).auto?.reason).toMatch(/network/);
    expect(p.check(bash("git push --force")).auto).toMatchObject({
      layer: "rule",
      decision: "ask",
    });
    expect(p.check(bash("terraform apply")).auto).toMatchObject({
      layer: "rule",
      decision: "deny",
    });
    expect(p.check(bash("node gen.js")).auto).toMatchObject({
      layer: "classifier",
      decision: "ask",
    });
    const read = p.check({ toolName: "read", permission: "read", input: {}, unattended: false });
    expect(read.auto).toMatchObject({ layer: "static", reason: "read-only tool" });
  });

  it("allow 规则放行未决定的调用，但越不过规则层", () => {
    const p = pipeline(
      "auto",
      [],
      ["bash(node *)", "bash(curl *)", "write(/tmp/**)", "read(.env)"],
    );
    expect(p.check(bash("node gen.js"))).toMatchObject({
      decision: "allow",
      step: "allow-rule",
      auto: { layer: "rule", decision: "allow" },
    });
    expect(p.check(bash("curl x")).decision).toBe("ask");
    const out = { toolName: "write", permission: "write" as const, input: { path: "/tmp/a" } };
    expect(p.check({ ...out, unattended: false }).decision).toBe("ask");
    const env = { toolName: "read", permission: "read" as const, input: { path: ".env" } };
    expect(p.check({ ...env, unattended: false }).decision).toBe("ask");
  });

  it("会话记忆放行未决定的调用", () => {
    const p = pipeline("auto");
    p.rememberForSession("bash", { command: "node gen.js" });
    expect(p.check(bash("node gen.js --force"))).toMatchObject({
      decision: "allow",
      step: "session",
    });
  });

  it("autoSafeCommands 追加安全名单；项目根可与 cwd 不同", () => {
    const p = new PermissionPipeline({
      mode: "auto",
      rules: [],
      cwd: resolve("/work/proj/sub"),
      projectRoot: cwd,
      autoSafeCommands: ["just test"],
    });
    expect(p.check(bash("just test")).decision).toBe("allow");
    const parent = { toolName: "write", permission: "write" as const, input: { path: "../a.ts" } };
    expect(p.check({ ...parent, unattended: false }).decision).toBe("allow");
    const out = { toolName: "write", permission: "write" as const, input: { path: "../../a.ts" } };
    expect(p.check({ ...out, unattended: false }).decision).toBe("ask");
  });

  it("非 bash 的执行类工具与没有 path 的写工具交给分类器", () => {
    const p = pipeline("auto");
    const codemode = { toolName: "codemode", permission: "execute" as const, input: { code: "1" } };
    expect(p.check({ ...codemode, unattended: false }).classify).toBe(true);
    const host = { toolName: "canvas_send", permission: "write" as const, input: { to: "x" } };
    expect(p.check({ ...host, unattended: false }).classify).toBe(true);
  });

  it("审计：保留最近 20 条，摘要单行截断", () => {
    const p = pipeline("auto");
    for (let i = 0; i < 25; i++) {
      p.recordAutoDecision(
        "bash",
        { command: `echo ${i}\nls` },
        {
          layer: "static",
          decision: "allow",
          reason: "safe",
        },
      );
    }
    const list = p.autoDecisions();
    expect(list).toHaveLength(20);
    expect(list[0]).toMatchObject({ toolName: "bash", summary: "echo 5 ls", layer: "static" });
    p.recordAutoDecision(
      "write",
      { path: "x".repeat(200) },
      {
        layer: "static",
        decision: "allow",
        reason: "w",
      },
    );
    expect(p.autoDecisions().at(-1)?.summary.length).toBe(80);
  });
});

describe("allowlist", () => {
  it("只放行 allow 规则命中的，拒绝说明写「不在允许名单」", () => {
    const p = pipeline("allowlist", [], ["write(src/**)", "bash(pnpm test*)"]);
    const write = (path: string) =>
      p.check({ toolName: "write", permission: "write", input: { path }, unattended: false });
    expect(write("src/a.ts").decision).toBe("allow");
    const denied = write("lib/a.ts");
    expect(denied).toMatchObject({ decision: "deny", step: "allowlist" });
    expect(denied.message).toContain("不在允许名单");
    const bash = (command: string) =>
      p.check({ toolName: "bash", permission: "execute", input: { command }, unattended: false });
    expect(bash("pnpm test --run").decision).toBe("allow");
    expect(bash("pnpm test && rm -rf build").decision).toBe("deny");
    expect(bash("pnpm publish").decision).toBe("deny");
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
