import { describe, expect, it } from "vitest";
import { memoryTransport, readRecording, replayPeer, spawnRecorder } from "../test-support.js";
import type { DriverEvent, DriverPermissionRequest, DriverPromptHooks } from "../types.js";
import { claudePermissionMode } from "./claude-normalize.js";
import { ClaudeStreamDriver, claudeArgs } from "./claude-stream.js";

const candidate = { kind: "claude-stream" as const, program: "claude", args: [] };

function replay(name: string) {
  const peer = replayPeer(readRecording(`claude/${name}`));
  const rec = spawnRecorder(() => memoryTransport((i, o) => peer.serve(i, o)));
  const driver = new ClaudeStreamDriver("claude", candidate, {
    spawn: rec.spawn,
    cancelGraceMs: 50,
  });
  return { peer, rec, driver };
}

const open = (
  driver: ClaudeStreamDriver,
  extra: Partial<Parameters<ClaudeStreamDriver["open"]>[0]> = {},
) =>
  driver.open({
    cwd: "/work",
    mode: "default",
    env: { PATH: "/bin" },
    signal: new AbortController().signal,
    ...extra,
  });

function hooks(
  events: DriverEvent[],
  answer: DriverPromptHooks["onPermission"] = async () => ({ outcome: "cancelled" }),
): DriverPromptHooks {
  return { onEvent: (e) => events.push(e), onPermission: answer };
}

describe("claudeArgs", () => {
  it("stream-json 双向、权限走 stdio、新会话固定 --session-id；不用 --bare", () => {
    const args = claudeArgs({ mode: "default" }, "sid-1");
    expect(args).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "manual",
      "--permission-prompt-tool",
      "stdio",
      "--session-id",
      "sid-1",
    ]);
    expect(args).not.toContain("--bare");
  });

  it("续聊 / 模型 / 预算 / 无人值守", () => {
    const args = claudeArgs(
      { mode: "plan", resume: "old", model: "sonnet", budgetUsd: 0.5, unattended: true },
      "unused",
    );
    expect(args).toEqual(expect.arrayContaining(["--resume", "old", "--model", "sonnet"]));
    expect(args).toEqual(expect.arrayContaining(["--max-budget-usd", "0.5"]));
    expect(args).toEqual(expect.arrayContaining(["--permission-prompts", "none"]));
    expect(args).not.toContain("--permission-prompt-tool");
    expect(args).not.toContain("--session-id");
  });

  it("模式映射：full-auto 不给 bypassPermissions", () => {
    expect(claudePermissionMode("plan", "manual")).toBe("plan");
    expect(claudePermissionMode("allowlist", "manual")).toBe("dontAsk");
    expect(claudePermissionMode("default", "default")).toBe("default");
    expect(claudePermissionMode("auto-edit", "manual")).toBe("acceptEdits");
    expect(claudePermissionMode("full-auto", "manual")).toBe("auto");
  });
});

describe("ClaudeStreamDriver（录制回放）", () => {
  it("两轮：流式文本只计一次、思考、成本按差值、会话 id 来自 result", async () => {
    const { peer, rec, driver } = replay("turn-basic.jsonl");
    const session = await open(driver);
    expect(rec.specs[0]!.args).toContain("--session-id");
    const events: DriverEvent[] = [];
    const r1 = await session.prompt([{ type: "text", text: "say OK" }], hooks(events));
    expect(r1).toMatchObject({
      stopReason: "end_turn",
      finalText: "OK",
      usage: { input: 3, output: 2, cacheRead: 12000, costUsd: 0.0123 },
    });
    expect(events.filter((e) => e.type === "message_delta").map((e) => e.text)).toEqual(["O", "K"]);
    expect(events.find((e) => e.type === "thought_delta")).toEqual({
      type: "thought_delta",
      text: "trivial",
    });
    expect(session.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    const r2 = await session.prompt([{ type: "text", text: "again" }], hooks([]));
    expect(r2.finalText).toBe("OK again");
    expect(r2.usage?.costUsd).toBeCloseTo(0.0077);
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("审批：本会话允许只回传 session 范围建议，updatedInput 原样；工具完成、文件计入", async () => {
    const { peer, driver } = replay("permission-allow.jsonl");
    const session = await open(driver);
    const requests: DriverPermissionRequest[] = [];
    const result = await session.prompt(
      [{ type: "text", text: "write note.txt" }],
      hooks([], async (req) => {
        requests.push(req);
        return { outcome: "selected", optionId: "allow_session" };
      }),
    );
    expect(requests[0]).toEqual({
      toolCall: {
        title: "Write: /work/note.txt",
        kind: "edit",
        locations: ["/work/note.txt"],
        inputSummary: '{"file_path":"/work/note.txt","content":"hi"}',
      },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "allow_session", kind: "allow_always" },
        { optionId: "deny", kind: "reject_once" },
      ],
    });
    expect(result).toMatchObject({
      finalText: "Wrote note.txt",
      filesTouched: ["/work/note.txt"],
      toolSummary: ["✓ edit Write: /work/note.txt"],
    });
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("审批：拒绝 → deny；没有会话范围建议时不提供「本会话允许」", async () => {
    const { peer, driver } = replay("permission-deny.jsonl");
    const session = await open(driver);
    let offered: string[] = [];
    const result = await session.prompt(
      [{ type: "text", text: "rm it" }],
      hooks([], async (req) => {
        offered = req.options.map((o) => o.kind);
        return { outcome: "selected", optionId: "deny" };
      }),
    );
    expect(offered).toEqual(["allow_once", "reject_once"]);
    expect(result.toolSummary).toEqual(["✗ execute Bash: rm -rf build"]);
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("中断：发 interrupt，result 缺 result 字段时以 cancelled 结束", async () => {
    const { peer, driver } = replay("interrupt.jsonl");
    const session = await open(driver);
    const events: DriverEvent[] = [];
    const p = session.prompt([{ type: "text", text: "long task" }], {
      onEvent: (e) => {
        events.push(e);
        if (e.type === "message_delta") void session.cancel();
      },
      onPermission: async () => ({ outcome: "cancelled" }),
    });
    await expect(p).resolves.toMatchObject({ stopReason: "cancelled", finalText: "Working" });
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("AskUserQuestion 不代答：拒绝并提示，不走审批", async () => {
    const { peer, driver } = replay("ask-question.jsonl");
    const session = await open(driver);
    const events: DriverEvent[] = [];
    let asked = false;
    const result = await session.prompt(
      [{ type: "text", text: "pick a lib" }],
      hooks(events, async () => {
        asked = true;
        return { outcome: "selected", optionId: "allow" };
      }),
    );
    expect(asked).toBe(false);
    expect(events.some((e) => e.type === "notice" && e.text.includes("不代答"))).toBe(true);
    expect(result.finalText).toContain("which library");
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("进程中途退出：回合以 agent_exited 失败", async () => {
    const rec = spawnRecorder(() =>
      memoryTransport(async (input, output) => {
        // 回应握手后、收到第一条用户消息就退出
        await new Promise<void>((resolve) => {
          let n = 0;
          input.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().split("\n").filter(Boolean)) {
              const msg = JSON.parse(line) as { type: string; request_id?: string };
              n++;
              if (msg.type === "control_request")
                output.write(
                  `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } })}\n`,
                );
              else if (n >= 2) resolve();
            }
          });
        });
      }),
    );
    const driver = new ClaudeStreamDriver("claude", candidate, { spawn: rec.spawn });
    const session = await open(driver);
    await expect(session.prompt([{ type: "text", text: "x" }], hooks([]))).rejects.toMatchObject({
      code: "agent_exited",
    });
  });
});
