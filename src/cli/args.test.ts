import { describe, expect, it } from "vitest";
import { HELP_TEXT, parseArgs, parseSubArgs, UsageError, type ParsedArgs } from "./args.js";

function run(argv: string[]): ParsedArgs {
  const result = parseArgs(argv);
  if (result.kind !== "run") throw new Error("expected run");
  return result.args;
}

function usage(argv: string[]): string {
  try {
    parseArgs(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    return (error as Error).message;
  }
  throw new Error(`应当报用法错误：${argv.join(" ")}`);
}

describe("parseArgs", () => {
  it("全部参数", () => {
    const args = run([
      "--profile=/p.json",
      "--host",
      "./h.cjs",
      "--instructions",
      "a.md",
      "--instructions",
      "b.md",
      "--skill-dir",
      "s",
      "--auth-file",
      "auth.json",
      "--permission-mode",
      "plan",
      "--allow",
      "bash(git *)",
      "--deny",
      "write(**)",
      "--model",
      "echo",
      "--provider",
      "fake",
      "--api-key",
      "k",
      "--thinking",
      "high",
      "--session-dir",
      "sd",
      "-p",
      "--output-format",
      "stream-json",
      "--no-tui",
      "--tui-mode",
      "regular",
      "--quiet-startup",
      "silent",
      "--trust",
      "--tools",
      "read,bash",
      "--exclude-tools=task",
      "--tools-preset",
      "minimal",
      "--codemode=only",
      "fix",
      "the bug",
    ]);
    expect(args).toMatchObject({
      profile: "/p.json",
      host: "./h.cjs",
      instructions: ["a.md", "b.md"],
      skillDirs: ["s"],
      authFile: "auth.json",
      permissionMode: "plan",
      allow: ["bash(git *)"],
      deny: ["write(**)"],
      model: "echo",
      provider: "fake",
      apiKey: "k",
      thinking: "high",
      sessionDir: "sd",
      print: true,
      outputFormat: "stream-json",
      noTui: true,
      tuiMode: "regular",
      quietStartup: "silent",
      trust: true,
      tools: ["read", "bash"],
      excludeTools: ["task"],
      toolsPreset: "minimal",
      codemode: "only",
      prompt: "fix the bug",
    });
  });

  it("会话参数与 --resume 可选 id", () => {
    expect(run(["-c"]).continue).toBe(true);
    expect(run(["--resume"])).toMatchObject({ resume: true });
    expect(run(["--resume", "abc-123"]).resumeId).toBe("abc-123");
    expect(run(["--resume", "fix the bug"])).toMatchObject({ resume: true, prompt: "fix the bug" });
    expect(run(["--resume=x y"]).resumeId).toBe("x y");
    expect(run(["--session-id", "s1"]).sessionId).toBe("s1");
    expect(run(["--fork", "f1"]).fork).toBe("f1");
    expect(run(["--mode", "rpc"]).mode).toBe("rpc");
    expect(run(["--", "--not-a-flag"]).prompt).toBe("--not-a-flag");
    expect(run(["--no-trust"]).trust).toBe(false);
  });

  it("互斥与取值校验 → UsageError（2）", () => {
    expect(usage(["-p", "--mode", "rpc"])).toMatch(/-p 与 --mode rpc/);
    expect(usage(["--continue", "--resume"])).toMatch(/--continue 与 --resume/);
    expect(usage(["--session-id", "a", "--fork", "b"])).toMatch(/不能同时使用/);
    expect(usage(["--api-key", "k"])).toMatch(/--model/);
    expect(usage(["--trust", "--no-trust"])).toMatch(/--trust/);
    expect(usage(["--output-format", "json"])).toMatch(/-p/);
    expect(usage(["--permission-mode", "yolo"])).toMatch(/plan/);
    expect(usage(["--thinking", "max"])).toMatch(/xhigh/);
    expect(usage(["--tui-mode", "fullscreen"])).toMatch(/fullscreen/);
    expect(usage(["--mode", "json"])).toMatch(/rpc/);
    expect(usage(["--tools-preset", "tiny"])).toMatch(
      /--tools-preset 的取值应为 default \| minimal \| codemode \| coordinator/,
    );
    expect(usage(["--codemode", "always"])).toMatch(/--codemode 的取值应为 off \| on \| only/);
    expect(usage(["--codemode"])).toMatch(/需要一个值/);
    expect(usage(["--model"])).toMatch(/需要一个值/);
    expect(usage(["--bogus"])).toMatch(/未知选项/);
    expect(usage(["-x"])).toMatch(/未知选项/);
    expect(usage(["--no-tui=1"])).toMatch(/不接受值/);
  });

  it("--provider 不带 --model 不在解析阶段报错（bootstrap 第 11 步报 2）", () => {
    expect(run(["--provider", "fake"]).provider).toBe("fake");
  });

  it("子命令只在第一个参数识别", () => {
    expect(parseArgs(["auth", "set", "x"])).toEqual({
      kind: "subcommand",
      name: "auth",
      argv: ["set", "x"],
    });
    expect(run(["explain", "auth"]).prompt).toBe("explain auth");
    const sub = parseSubArgs(["list", "--provider=x", "--all"], ["provider"], ["all"]);
    expect(sub.positionals).toEqual(["list"]);
    expect(sub.values.get("provider")).toBe("x");
    expect(sub.flags.has("all")).toBe(true);
  });

  it("--help 文本覆盖全部参数与子命令", () => {
    for (const flag of [
      "--profile",
      "--host",
      "--instructions",
      "--skill-dir",
      "--auth-file",
      "--permission-mode",
      "--allow",
      "--deny",
      "--model",
      "--provider",
      "--api-key",
      "--thinking",
      "--continue",
      "--resume",
      "--session-id",
      "--fork",
      "--session-dir",
      "--print",
      "--output-format",
      "--mode rpc",
      "--no-tui",
      "--tui-mode",
      "--quiet-startup",
      "--trust",
      "--no-trust",
      "--tools",
      "--exclude-tools",
      "--tools-preset",
      "--codemode",
      "--version",
      "--help",
      "ama auth set",
      "ama sessions",
      "ama models",
      "ama doctor",
    ]) {
      expect(HELP_TEXT).toContain(flag);
    }
    expect(run(["--help", "--continue", "--resume"]).help).toBe(true);
  });
});
