import { describe, expect, it } from "vitest";
import { memoryTransport, readRecording, spawnRecorder } from "../test-support.js";
import type { DriverEvent } from "../types.js";
import { OneshotDriver, oneshotArgs } from "./oneshot.js";

/** 读完 stdin 后写出录制的输出行。 */
function outputs(name: string) {
  const lines = readRecording(`oneshot/${name}`).filter((w) => w.dir === "out");
  const stdin: string[] = [];
  const rec = spawnRecorder(() =>
    memoryTransport(
      (input, output) =>
        new Promise<void>((resolve) => {
          input.on("data", (c: Buffer) => stdin.push(c.toString("utf8")));
          input.on("end", () => {
            for (const l of lines) output.write(`${JSON.stringify(l.msg)}\n`);
            resolve();
          });
        }),
    ),
  );
  return { rec, stdin };
}

const hooks = (events: DriverEvent[]) => ({
  onEvent: (e: DriverEvent) => events.push(e),
  onPermission: async () => ({ outcome: "cancelled" as const }),
});

const open = (driver: OneshotDriver, mode: "plan" | "default" = "plan", resume?: string) =>
  driver.open({
    cwd: "/work",
    mode,
    env: {},
    signal: new AbortController().signal,
    ...(resume !== undefined ? { resume } : {}),
  });

describe("oneshotArgs", () => {
  it("一律只读启动", () => {
    expect(oneshotArgs("claude", {}, { id: "s", resume: false }, "p")).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "--permission-prompts",
      "none",
      "--session-id",
      "s",
    ]);
    expect(oneshotArgs("codex", { model: "m" }, { id: "t", resume: true }, "p")).toEqual([
      "exec",
      "resume",
      "t",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
      "-m",
      "m",
      "-",
    ]);
    // ama 只在已信任目录里起：非 git 目录也不能被 codex 的仓库检查挡住（#198）
    expect(oneshotArgs("codex", {}, { id: "", resume: false }, "p").slice(0, 3)).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
    ]);
    expect(oneshotArgs("gemini", {}, { id: "", resume: false }, "hello")).toEqual([
      "--output-format",
      "stream-json",
      "--approval-mode",
      "default",
      "-p",
      "hello",
    ]);
  });
});

describe("OneshotDriver（录制回放）", () => {
  it("不能审批：非只读模式拒绝打开", async () => {
    const driver = new OneshotDriver("claude", {
      kind: "oneshot",
      program: "claude",
      args: [],
      oneshot: "claude",
    });
    await expect(open(driver, "default")).rejects.toMatchObject({ code: "agent_mode_unsupported" });
  });

  it("claude -p json：提示走 stdin，结果、成本、会话 id", async () => {
    const { rec, stdin } = outputs("claude-json.jsonl");
    const driver = new OneshotDriver(
      "claude",
      { kind: "oneshot", program: "claude", args: [], oneshot: "claude" },
      { spawn: rec.spawn },
    );
    const session = await open(driver);
    const result = await session.prompt([{ type: "text", text: "find foo" }], hooks([]));
    expect(stdin.join("")).toBe("find foo");
    expect(result).toMatchObject({
      stopReason: "end_turn",
      finalText: "Found 3 call sites.",
      usage: { input: 20, output: 8, cacheRead: 9000, costUsd: 0.05 },
    });
    expect(session.sessionId).toBe("66666666-6666-4666-8666-666666666666");
    await session.prompt([{ type: "text", text: "more" }], hooks([])).catch(() => undefined);
    expect(rec.specs[1]!.args).toEqual(
      expect.arrayContaining(["--resume", "66666666-6666-4666-8666-666666666666"]),
    );
  });

  it("codex exec --json：线程 id、命令条目、最终文本与用量；第二回合 exec resume", async () => {
    const { rec } = outputs("codex-exec.jsonl");
    const driver = new OneshotDriver(
      "codex",
      { kind: "oneshot", program: "codex", args: [], oneshot: "codex" },
      { spawn: rec.spawn },
    );
    const session = await open(driver);
    const events: DriverEvent[] = [];
    const result = await session.prompt([{ type: "text", text: "where is foo" }], hooks(events));
    expect(result).toMatchObject({
      finalText: "foo is in a.ts",
      toolSummary: ["✓ execute $ rg foo"],
      usage: { input: 400, output: 20, cacheRead: 100 },
    });
    expect(session.sessionId).toBe("019a0000-0000-7000-8000-0000000000aa");
    await session.prompt([{ type: "text", text: "again" }], hooks([]));
    expect(rec.specs[1]!.args.slice(0, 3)).toEqual([
      "exec",
      "resume",
      "019a0000-0000-7000-8000-0000000000aa",
    ]);
  });

  it("gemini stream-json：工具与文本", async () => {
    const { rec } = outputs("gemini-stream.jsonl");
    const driver = new OneshotDriver(
      "gemini",
      { kind: "oneshot", program: "gemini", args: [], oneshot: "gemini" },
      { spawn: rec.spawn },
    );
    const session = await open(driver);
    const result = await session.prompt([{ type: "text", text: "q" }], hooks([]));
    expect(result).toMatchObject({
      finalText: "a.ts exports foo",
      toolSummary: ["✓ other read_file"],
      usage: { input: 50, output: 10 },
    });
  });
});
