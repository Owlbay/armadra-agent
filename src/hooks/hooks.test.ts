import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTmpHome, withTmpHome } from "../../test/helpers/tmp-home.js";
import { StartupError } from "../errors.js";
import { hooksFromConfig, loadHookConfigs, type LoadedHook } from "./config.js";
import { HookDispatcher, type HookCommonContext, type HookExecutor } from "./dispatcher.js";
import { compileMatcher, splitAlternatives } from "./matcher.js";
import { hookEnv, mergeResults, parseHookOutput } from "./protocol.js";
import { runHookCommand } from "./runner.js";
import type { HookEvent, HookInput, HookRunResult } from "./types.js";

const scripts = createTmpHome("ama-hook-scripts-");
afterAll(() => scripts.cleanup());
let counter = 0;

/** 用 node 脚本做 Hook：写入临时 .cjs，命令为 `"<node>" "<file>"`（sh / bash / cmd 通用）。 */
function nodeHook(source: string): string {
  const file = scripts.path(`hook-${counter++}.cjs`).replace(/\\/g, "/");
  writeFileSync(file, source);
  return `"${process.execPath.replace(/\\/g, "/")}" "${file}"`;
}

const READ_STDIN = `let raw = ""; process.stdin.on("data", (c) => (raw += c)); process.stdin.on("end", () => main(JSON.parse(raw)));`;

function hook(event: HookEvent, command: string, extra: Partial<LoadedHook> = {}): LoadedHook {
  return {
    event,
    command,
    timeoutMs: 10_000,
    source: "user",
    file: "test",
    order: counter++,
    ...extra,
  };
}

const context = (): HookCommonContext => ({
  sessionId: "s-1",
  cwd: scripts.cwd,
  model: { provider: "fake", id: "echo" },
  permissionMode: "default",
  depth: 0,
});

function input(event: HookEvent, extra: Partial<HookInput> = {}): HookInput {
  return { ...context(), hookEventName: event, ...extra };
}

function result(event: HookEvent, extra: Partial<HookRunResult>): HookRunResult {
  return {
    event,
    command: "c",
    source: "user",
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    stdout: "",
    stderr: "",
    ...extra,
  };
}

describe("matcher", () => {
  it("缺省 / 精确 / 多选 / glob / 括号参数 / 正则", () => {
    expect(compileMatcher(undefined)("anything", {})).toBe(true);
    expect(compileMatcher("bash")("bash", {})).toBe(true);
    expect(compileMatcher("bash")("bash_x", {})).toBe(false);
    expect(compileMatcher("write|edit")("edit", {})).toBe(true);
    expect(compileMatcher("canvas_*")("canvas_send", {})).toBe(true);
    const push = compileMatcher("bash(git push*)");
    expect(push("bash", { command: "git push origin main" })).toBe(true);
    expect(push("bash", { command: "git status" })).toBe(false);
    expect(compileMatcher("write(src/*)")("write", { path: "src/a/b.ts" })).toBe(true);
    expect(compileMatcher("/^(read|ls)$/")("ls", {})).toBe(true);
    expect(compileMatcher("/^(read|ls)$/")("lsx", {})).toBe(false);
    expect(splitAlternatives("bash(a|b)|edit")).toEqual(["bash(a|b)", "edit"]);
    expect(() => compileMatcher("/(/")).toThrow();
  });
});

describe("protocol", () => {
  it("stdout：空 / 非 JSON → 无决策；字段校验", () => {
    expect(parseHookOutput("").output).toBeUndefined();
    expect(parseHookOutput("hello").output).toBeUndefined();
    const parsed = parseHookOutput('{"decision":"maybe","reason":1,"continue":false}');
    expect(parsed.output).toEqual({ continue: false });
    expect(parsed.warnings).toHaveLength(2);
  });

  it("合并：deny > block > ask > allow；reason 来自决定性 Hook", () => {
    const outcome = mergeResults([
      result("PreToolUse", { output: { decision: "allow", reason: "a" } }),
      result("PreToolUse", { output: { decision: "ask", reason: "b" } }),
      result("PreToolUse", { exitCode: 2, stderr: "blocked by policy\n" }),
    ]);
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toBe("blocked by policy");
    const ask = mergeResults([
      result("PreToolUse", { output: { decision: "allow" } }),
      result("PreToolUse", { output: { decision: "ask", reason: "check" } }),
    ]);
    expect(ask).toMatchObject({ decision: "ask", reason: "check" });
  });

  it("updatedInput 只接受唯一返回者；additionalContext 按顺序拼接", () => {
    const one = mergeResults([
      result("PreToolUse", { output: { updatedInput: { a: 1 }, additionalContext: "x" } }),
      result("PreToolUse", { output: { additionalContext: "y" } }),
    ]);
    expect(one).toMatchObject({
      hasUpdatedInput: true,
      updatedInput: { a: 1 },
      additionalContext: "x\n\ny",
    });
    const two = mergeResults([
      result("PreToolUse", { output: { updatedInput: { a: 1 } } }),
      result("PreToolUse", { output: { updatedInput: { a: 2 } } }),
    ]);
    expect(two.hasUpdatedInput).toBe(false);
    expect(two.warnings.join()).toMatch(/updatedInput/);
  });

  it("超时：PreToolUse 按 deny，其它事件只 warning；非 0/2 退出码非阻塞", () => {
    const pre = mergeResults([result("PreToolUse", { exitCode: null, timedOut: true })]);
    expect(pre.decision).toBe("deny");
    const post = mergeResults([result("PostToolUse", { exitCode: null, timedOut: true })]);
    expect(post.decision).toBeUndefined();
    expect(post.warnings).toHaveLength(1);
    const failed = mergeResults([result("Stop", { exitCode: 1, stderr: "boom" })]);
    expect(failed.decision).toBeUndefined();
    expect(failed.warnings[0]).toMatch(/boom/);
    // 事件不接受的决策被忽略；Notification 的退出码 2 忽略
    expect(
      mergeResults([result("Stop", { output: { decision: "allow" } })]).decision,
    ).toBeUndefined();
    expect(mergeResults([result("Notification", { exitCode: 2 })]).decision).toBeUndefined();
    expect(mergeResults([result("UserPromptSubmit", { exitCode: 2, stderr: "no" })]).decision).toBe(
      "block",
    );
  });

  it("环境变量", () => {
    const env = hookEnv(input("PreToolUse", { toolName: "edit", toolInput: { path: "a.ts" } }));
    expect(env).toMatchObject({
      AMA_HOOK_EVENT: "PreToolUse",
      AMA_SESSION_ID: "s-1",
      AMA_TOOL_NAME: "edit",
      AMA_FILE: "a.ts",
    });
  });
});

describe("runner（node 脚本做 Hook）", () => {
  it("退出码 0：stdin 收到 JSON、环境变量齐全、stdout JSON 被解析", async () => {
    const command = nodeHook(
      `${READ_STDIN} function main(i) { console.log(JSON.stringify({ decision: "allow", reason: i.toolName + ":" + process.env.AMA_TOOL_NAME + ":" + process.env.AMA_HOOK_EVENT })); }`,
    );
    const r = await runHookCommand(
      hook("PreToolUse", command),
      input("PreToolUse", { toolName: "bash" }),
      {
        cwd: scripts.cwd,
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toEqual({ decision: "allow", reason: "bash:bash:PreToolUse" });
  });

  it("退出码 2：stderr 作为 reason", async () => {
    const command = nodeHook(`process.stderr.write("rm 不允许"); process.exit(2);`);
    const r = await runHookCommand(hook("PreToolUse", command), input("PreToolUse"), {
      cwd: scripts.cwd,
    });
    expect(r.exitCode).toBe(2);
    expect(mergeResults([r])).toMatchObject({ decision: "deny", reason: "rm 不允许" });
  });

  it("其它退出码：非阻塞 warning", async () => {
    const command = nodeHook(`process.stderr.write("crash"); process.exit(3);`);
    const r = await runHookCommand(hook("PostToolUse", command), input("PostToolUse"), {
      cwd: scripts.cwd,
    });
    const outcome = mergeResults([r]);
    expect(r.exitCode).toBe(3);
    expect(outcome.decision).toBeUndefined();
    expect(outcome.warnings[0]).toMatch(/退出码 3/);
  });

  it("超时：杀掉进程；PreToolUse 超时按 deny", async () => {
    const command = nodeHook(`setTimeout(() => {}, 20000);`);
    const started = Date.now();
    const r = await runHookCommand(
      hook("PreToolUse", command, { timeoutMs: 300 }),
      input("PreToolUse"),
      {
        cwd: scripts.cwd,
      },
    );
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(mergeResults([r]).decision).toBe("deny");
  });

  it("Hook 不读 stdin 直接退出不报错", async () => {
    const command = nodeHook(`process.exit(0);`);
    const r = await runHookCommand(
      hook("Stop", command),
      input("Stop", { lastAssistantText: "x".repeat(200_000) }),
      {
        cwd: scripts.cwd,
      },
    );
    expect(r.exitCode).toBe(0);
  });
});

describe("dispatcher", () => {
  it("并行运行并合并；matcher 过滤；hook_executed 回调", async () => {
    const slow = (decision: string, extra = "") =>
      nodeHook(
        `setTimeout(() => console.log(JSON.stringify({ decision: "${decision}"${extra} })), 1000);`,
      );
    const executed: string[] = [];
    const dispatcher = new HookDispatcher({
      hooks: [
        hook("PreToolUse", slow("allow", `, updatedInput: { command: "git status" }`), {
          matcher: "bash",
        }),
        hook("PreToolUse", slow("ask"), { matcher: "bash(git *)" }),
        hook("PreToolUse", slow("deny"), { matcher: "write" }),
      ],
      context,
      onExecuted: (r) => executed.push(r.command),
    });
    expect(dispatcher.has("PreToolUse", "bash")).toBe(true);
    expect(dispatcher.has("PreToolUse", "read")).toBe(false);
    expect(dispatcher.has("Stop")).toBe(false);
    const started = Date.now();
    const outcome = await dispatcher.run("PreToolUse", {
      toolName: "bash",
      toolInput: { command: "git push" },
    });
    const elapsed = Date.now() - started;
    expect(outcome.decision).toBe("ask");
    expect(outcome.updatedInput).toEqual({ command: "git status" });
    expect(outcome.results).toHaveLength(2);
    expect(executed).toHaveLength(2);
    // 两条各 1000 ms：串行至少 2000 ms，并行应明显更少（给子进程启动留余量）
    expect(elapsed).toBeLessThan(1_900);
    expect((await dispatcher.run("Stop", {})).results).toHaveLength(0);
    expect(dispatcher.list().map((h) => h.matcher)).toEqual(["bash", "bash(git *)", "write"]);
  });

  it("非工具事件忽略 matcher；SessionStart 退出码 2 → block", async () => {
    const dispatcher = new HookDispatcher({
      hooks: [
        hook("SessionStart", nodeHook(`process.stderr.write("no"); process.exit(2);`), {
          matcher: "zzz",
        }),
      ],
      context,
    });
    const outcome = await dispatcher.run("SessionStart", { source: "startup" });
    expect(outcome).toMatchObject({ decision: "block", reason: "no" });
  });
});

describe("dispatcher：按次覆盖公共字段（契约 A2）", () => {
  function capture(): { inputs: HookInput[]; executor: HookExecutor } {
    const inputs: HookInput[] = [];
    return {
      inputs,
      executor: async (hooks, hookInput) => {
        inputs.push(hookInput);
        return hooks.map(() => result(hookInput.hookEventName, {}));
      },
    };
  }

  it("第 4 参数覆盖 depth / sessionId / sessionFile，其余取缺省；undefined 不覆盖", async () => {
    const { inputs, executor } = capture();
    const dispatcher = new HookDispatcher({
      hooks: [hook("PreToolUse", "x")],
      context: () => ({ ...context(), sessionFile: "/main.jsonl" }),
      executor,
    });
    await dispatcher.run("PreToolUse", { toolName: "read" });
    await dispatcher.run(
      "PreToolUse",
      { toolName: "read", viaCodemode: true, parentToolCallId: "c1" },
      undefined,
      { depth: 1, sessionId: "s-child", sessionFile: "/child.jsonl", cwd: undefined },
    );
    expect(inputs[0]).toMatchObject({ depth: 0, sessionId: "s-1", sessionFile: "/main.jsonl" });
    expect(inputs[0]).not.toHaveProperty("viaCodemode");
    expect(inputs[1]).toMatchObject({
      hookEventName: "PreToolUse",
      depth: 1,
      sessionId: "s-child",
      sessionFile: "/child.jsonl",
      cwd: scripts.cwd,
      model: { provider: "fake", id: "echo" },
      viaCodemode: true,
      parentToolCallId: "c1",
    });
  });

  it("覆盖的 cwd 同时作为 Hook 子进程的工作目录", async () => {
    const cwds: string[] = [];
    const dispatcher = new HookDispatcher({
      hooks: [hook("Stop", "x")],
      context,
      executor: async (hooks, hookInput, options) => {
        cwds.push(options.cwd);
        return hooks.map(() => result(hookInput.hookEventName, {}));
      },
    });
    await dispatcher.run("Stop", {}, undefined, { cwd: "/elsewhere" });
    expect(cwds).toEqual(["/elsewhere"]);
  });
});

describe("hooks 配置：三层拼接与信任过滤", () => {
  it("用户级 → profile → 项目级（需信任）", async () => {
    await withTmpHome((home) => {
      const cmd = (name: string) => ({ type: "command", command: name });
      home.write("home/.config/ama/hooks.json", {
        version: 1,
        hooks: { PreToolUse: [{ matcher: "bash", hooks: [cmd("user")] }] },
      });
      const profileFile = home.write("profile/hooks.json", {
        version: 1,
        hooks: {
          PreToolUse: [{ hooks: [cmd("profile")] }],
          Stop: [{ hooks: [cmd("profile-stop")] }],
        },
      });
      home.write("work/.ama/hooks.json", {
        version: 1,
        hooks: { PreToolUse: [{ hooks: [{ ...cmd("project"), timeoutMs: 5 }] }] },
      });
      const base = { configDir: home.configDir, cwd: home.cwd, profileHooksFile: profileFile };
      const untrusted = loadHookConfigs({ ...base, trusted: false });
      expect(untrusted.hooks.map((h) => h.command)).toEqual(["user", "profile", "profile-stop"]);
      expect(untrusted.skippedProject).toBe(join(home.cwd, ".ama", "hooks.json"));
      const trusted = loadHookConfigs({ ...base, trusted: true, defaultTimeoutMs: 1234 });
      expect(
        trusted.hooks
          .filter((h) => h.event === "PreToolUse")
          .map((h) => `${h.source}:${h.command}`),
      ).toEqual(["user:user", "profile:profile", "project:project"]);
      expect(trusted.hooks.find((h) => h.command === "user")?.timeoutMs).toBe(1234);
      expect(trusted.hooks.find((h) => h.command === "project")?.timeoutMs).toBe(5);
    });
  });

  it("语法错误 / 非法 matcher → 3；未信任的项目级语法错误不阻断", async () => {
    await withTmpHome((home) => {
      home.write("work/.ama/hooks.json", "{ not json");
      expect(() =>
        loadHookConfigs({ configDir: home.configDir, cwd: home.cwd, trusted: false }),
      ).not.toThrow();
      try {
        loadHookConfigs({ configDir: home.configDir, cwd: home.cwd, trusted: true });
        expect.unreachable();
      } catch (error) {
        expect((error as StartupError).exitCode).toBe(3);
      }
      expect(() =>
        hooksFromConfig({ version: 1, hooks: { PreToolUse: [{ matcher: "/(/", hooks: [] }] } }),
      ).toThrow(StartupError);
    });
  });
});
