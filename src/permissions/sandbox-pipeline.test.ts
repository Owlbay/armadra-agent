/**
 * [S2] 「沙箱内命令免审批」真值表（docs/permissions.md「判定顺序」）：模式 × 是否在沙箱内 × 危险命令 /
 * deny 规则 / Hook ask / 机密路径 / sandbox:false × 无人值守 → 放行 / 询问 / 拒绝。沙箱状态用假的，
 * 不依赖本机。
 */

import { describe, expect, it } from "vitest";
import { resolveBashSandbox, type BashSandbox } from "../sandbox/bash.js";
import type { OsSandboxStatus } from "../sandbox/detect.js";
import { PermissionPipeline } from "./pipeline.js";
import { parseRule } from "./rules.js";
import type { Decision, PermissionMode } from "./types.js";

const SEATBELT: OsSandboxStatus = {
  kind: "sandbox-exec",
  path: "/usr/bin/sandbox-exec",
  isolatesNetwork: true,
  restrictsWrites: true,
  detail: "fake",
};
const UNSHARE: OsSandboxStatus = { ...SEATBELT, kind: "unshare", restrictsWrites: false };

type Env = "deny" | "allow" | "off" | "unshare";
function sandboxFor(env: Env): BashSandbox {
  if (env === "unshare") return resolveBashSandbox({ bash: "auto" }, { status: UNSHARE });
  return resolveBashSandbox(
    { bash: env === "off" ? "off" : "auto", network: env === "off" ? "deny" : env },
    { status: SEATBELT },
  );
}

function pipeline(mode: PermissionMode, env: Env): PermissionPipeline {
  const sandbox = sandboxFor(env);
  return new PermissionPipeline({
    mode,
    rules: [parseRule("bash(terraform *)", "deny", "user")],
    cwd: "/work",
    ...(sandbox.active ? { bashSandbox: sandbox } : {}),
  });
}

interface Call {
  command: string;
  sandbox?: boolean;
  hook?: "ask" | "allow";
}

function decide(mode: PermissionMode, env: Env, call: Call, unattended = false) {
  const input: Record<string, unknown> = { command: call.command };
  if (call.sandbox !== undefined) input["sandbox"] = call.sandbox;
  return pipeline(mode, env).check({
    toolName: "bash",
    permission: "execute",
    input,
    unattended,
    ...(call.hook !== undefined ? { hookDecision: call.hook } : {}),
  });
}

const PLAIN: Call = { command: "node scripts/gen.js && rm -r dist" };
const DANGEROUS: Call = { command: "git push --force origin main" };
const DENIED: Call = { command: "terraform apply" };
const HOOK_ASK: Call = { ...PLAIN, hook: "ask" };
const SECRET: Call = { command: "cat .env" };
const ESCAPE: Call = { ...PLAIN, sandbox: false };
const READONLY: Call = { command: "ls src" };

describe("default / auto-edit：沙箱内免审批", () => {
  const rows: [string, Env, Call, Decision, Decision][] = [
    // 名称, 沙箱, 调用, 有人值守, 无人值守
    ["沙箱内普通命令", "deny", PLAIN, "allow", "allow"],
    ["危险命令仍询问", "deny", DANGEROUS, "ask", "deny"],
    ["deny 规则仍拒绝", "deny", DENIED, "deny", "deny"],
    ["Hook ask 仍询问", "deny", HOOK_ASK, "ask", "deny"],
    ["碰机密路径仍询问", "deny", SECRET, "ask", "deny"],
    ["sandbox:false 走正常审批", "deny", ESCAPE, "ask", "deny"],
    ["network: allow 不免审批", "allow", PLAIN, "ask", "deny"],
    ["sandbox.bash: off 照旧", "off", PLAIN, "ask", "deny"],
    ["unshare 不算（不限制写入）", "unshare", PLAIN, "ask", "deny"],
  ];
  for (const mode of ["default", "auto-edit"] as const) {
    for (const [name, env, call, attended, unattended] of rows) {
      it(`${mode}：${name}`, () => {
        const a = decide(mode, env, call);
        expect(a.decision).toBe(attended);
        expect(decide(mode, env, call, true).decision).toBe(unattended);
        if (attended === "allow") expect(a.sandboxed).toBe(true);
        else expect(a.sandboxed).toBeUndefined();
      });
    }
  }

  it("嵌套命令里的机密路径与 deny 规则同样生效", () => {
    expect(decide("default", "deny", { command: "sh -c 'cat .env'" }).decision).toBe("ask");
    expect(decide("default", "deny", { command: "bash -c 'terraform apply'" }).decision).toBe(
      "deny",
    );
  });

  it("后台任务查询照旧按读处理", () => {
    const v = pipeline("default", "deny").check({
      toolName: "bash",
      permission: "execute",
      input: { job: "j1", action: "output" },
      unattended: true,
    });
    expect(v.decision).toBe("allow");
  });
});

describe("其它模式语义不变", () => {
  it("plan / allowlist：沙箱不放宽（只读命令放行，其余拒绝）", () => {
    for (const mode of ["plan", "allowlist"] as const) {
      expect(decide(mode, "deny", PLAIN).decision).toBe("deny");
      expect(decide(mode, "deny", READONLY).decision).toBe("allow");
      expect(decide(mode, "deny", ESCAPE).decision).toBe("deny");
    }
  });

  it("full-auto：照旧放行（危险命令仍询问）", () => {
    expect(decide("full-auto", "deny", PLAIN).decision).toBe("allow");
    expect(decide("full-auto", "deny", ESCAPE).decision).toBe("allow");
    expect(decide("full-auto", "deny", DANGEROUS).decision).toBe("ask");
  });

  it("auto：沙箱不直接放行，作为分类器输入；规则层照旧", () => {
    const plain = decide("auto", "deny", { command: "node scripts/gen.js" });
    expect(plain.decision).toBe("ask");
    expect(plain.classify).toBe(true);
    expect(plain.sandboxed).toBe(true);
    // 删除类在规则层询问，不因沙箱放行
    const rm = decide("auto", "deny", PLAIN);
    expect(rm.step).toBe("auto-rule");
    expect(rm.classify).toBeUndefined();
    // 沙箱关闭时分类器拿不到沙箱信息
    expect(decide("auto", "off", { command: "node scripts/gen.js" }).sandboxed).toBeUndefined();
    // 安全名单照旧静态放行
    expect(decide("auto", "deny", READONLY).decision).toBe("allow");
  });

  it("auto：sandbox:false 越出沙箱在规则层询问（不交给分类器），无人值守拒绝", () => {
    const v = decide("auto", "deny", { command: "ls src", sandbox: false });
    expect(v.decision).toBe("ask");
    expect(v.step).toBe("auto-rule");
    expect(v.classify).toBeUndefined();
    expect(decide("auto", "deny", { command: "ls src", sandbox: false }, true).decision).toBe(
      "deny",
    );
    // 沙箱没生效时 sandbox:false 无意义，按原来的判定
    expect(decide("auto", "off", { command: "ls src", sandbox: false }).decision).toBe("allow");
  });

  it("auto：allow 规则可以放行越出沙箱的调用（用户明确授权）", () => {
    const p = new PermissionPipeline({
      mode: "auto",
      rules: [parseRule("bash(node scripts/*)", "allow", "user")],
      cwd: "/work",
      bashSandbox: sandboxFor("deny"),
    });
    const v = p.check({
      toolName: "bash",
      permission: "execute",
      input: { command: "node scripts/gen.js", sandbox: false },
      unattended: true,
    });
    expect(v.decision).toBe("allow");
    expect(v.step).toBe("allow-rule");
  });
});
