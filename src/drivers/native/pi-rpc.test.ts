import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { candidateCapabilities, catalogEntry } from "../catalog.js";
import { memoryTransport, readRecording, replayPeer, spawnRecorder } from "../test-support.js";
import type { DriverEvent, DriverPermissionRequest, DriverPromptHooks } from "../types.js";
import { PI_GATE_SOURCE, PI_GATE_TITLE, writePiGate } from "./pi-gate.js";
import { PiRpcDriver, piArgs, piToolKind } from "./pi-rpc.js";

const candidate = catalogEntry("pi")!.candidates[0]!;

function replay(name: string) {
  const peer = replayPeer(readRecording(`pi/${name}`));
  const rec = spawnRecorder(() => memoryTransport((i, o) => peer.serve(i, o)));
  const driver = new PiRpcDriver("pi", candidate, { spawn: rec.spawn, cancelGraceMs: 50 });
  return { peer, rec, driver };
}

const open = (driver: PiRpcDriver, extra: Partial<Parameters<PiRpcDriver["open"]>[0]> = {}) =>
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

describe("piArgs / 驱动表", () => {
  it("rpc 模式、--session-id 固定会话、模型透传、加载审批闸；只读模式只开只读工具", () => {
    expect(candidate).toMatchObject({ kind: "pi-rpc", program: "pi", args: ["--mode", "rpc"] });
    expect(piArgs({ mode: "default", model: "openai-codex/gpt-6-luna" }, "s-1", "/g.ts")).toEqual([
      "--session-id",
      "s-1",
      "--model",
      "openai-codex/gpt-6-luna",
      "-e",
      "/g.ts",
    ]);
    expect(piArgs({ mode: "plan" }, "s-1", "/g.ts")).toEqual([
      "--session-id",
      "s-1",
      "-e",
      "/g.ts",
      "--tools",
      "read,grep,find,ls",
    ]);
    expect(candidateCapabilities(candidate)).toMatchObject({
      permissions: "interactive",
      steer: true,
      usage: "usd",
      resume: "resume",
    });
    expect(piToolKind("bash")).toBe("execute");
    expect(piToolKind("write")).toBe("edit");
    expect(piToolKind("grep")).toBe("search");
  });

  it("审批闸：只读内置工具以外都经 confirm 交给 ama；文件写在私有临时目录、可清理", () => {
    expect(PI_GATE_SOURCE).toContain(JSON.stringify(PI_GATE_TITLE));
    expect(PI_GATE_SOURCE).toContain('["read","grep","find","ls"]');
    const gate = writePiGate();
    expect(readFileSync(gate.path, "utf8")).toBe(PI_GATE_SOURCE);
    gate.dispose();
    expect(existsSync(gate.path)).toBe(false);
  });
});

describe("PiRpcDriver（录制回放）", () => {
  it("一轮：会话 id 来自 get_state，文本、用量（含 pi 估算的美元）与上下文", async () => {
    const { peer, rec, driver } = replay("turn-basic.jsonl");
    const session = await open(driver, { model: "openai-codex/gpt-6-luna" });
    expect(rec.specs[0]!.args.slice(0, 4)).toEqual([
      "--mode",
      "rpc",
      "--session-id",
      rec.specs[0]!.args[3],
    ]);
    expect(session.sessionId).toBe("c6738909-4821-4a13-bad7-c2352be9feec");
    const events: DriverEvent[] = [];
    const r = await session.prompt(
      [{ type: "text", text: "Reply with exactly OK and nothing else." }],
      hooks(events),
    );
    expect(r).toMatchObject({ stopReason: "end_turn", finalText: "OK" });
    expect(r.usage).toMatchObject({ input: 1803, output: 5, cacheRead: 0 });
    expect(r.usage?.costUsd).toBeCloseTo(0.0001828);
    expect(events.find((e) => e.type === "usage" && e.contextTokens !== undefined)).toEqual({
      type: "usage",
      contextTokens: 1808,
      contextWindow: 272000,
    });
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("审批：write 经审批闸交人 → 允许；工具完成、文件计入", async () => {
    const { peer, driver } = replay("approval-write.jsonl");
    const session = await open(driver);
    const asked: DriverPermissionRequest[] = [];
    const r = await session.prompt(
      [
        {
          type: "text",
          text: "Create a file named note.txt in the current directory containing the single word hi. Use your file-writing tool, then reply DONE.",
        },
      ],
      hooks([], async (req) => {
        asked.push(req);
        return { outcome: "selected", optionId: "allow" };
      }),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.toolCall).toMatchObject({
      title: "write note.txt",
      kind: "edit",
      locations: ["/work/note.txt"],
    });
    expect(asked[0]!.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(r.finalText).toBe("DONE");
    expect(r.filesTouched).toEqual(["/work/note.txt"]);
    expect(r.usage).toMatchObject({ input: 2181, output: 27, cacheRead: 1536 });
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("auto-edit：write 不问人直接放行；plan：审批闸一律拒绝、不问人", async () => {
    for (const [mode, confirmed] of [
      ["auto-edit", true],
      ["plan", false],
    ] as const) {
      const recording = readRecording("pi/approval-write.jsonl").map((w) =>
        w.msg["type"] === "extension_ui_response" ? { ...w, msg: { ...w.msg, confirmed } } : w,
      );
      const peer = replayPeer(recording);
      const rec = spawnRecorder(() => memoryTransport((i, o) => peer.serve(i, o)));
      const driver = new PiRpcDriver("pi", candidate, { spawn: rec.spawn });
      const session = await open(driver, { mode });
      let asked = 0;
      await session.prompt(
        [
          {
            type: "text",
            text: "Create a file named note.txt in the current directory containing the single word hi. Use your file-writing tool, then reply DONE.",
          },
        ],
        hooks([], async () => {
          asked++;
          return { outcome: "selected", optionId: "allow" };
        }),
      );
      expect(asked, mode).toBe(0);
      expect(peer.mismatches, mode).toEqual([]);
      await session.close();
    }
  });

  it("中断：发 abort，agent_settled{aborted} → cancelled，部分文本保留", async () => {
    const { peer, driver } = replay("interrupt.jsonl");
    const session = await open(driver);
    const r = await session.prompt([{ type: "text", text: "count to 400" }], {
      onEvent: (e) => {
        if (e.type === "message_delta") void session.cancel();
      },
      onPermission: async () => ({ outcome: "cancelled" }),
    });
    expect(r).toMatchObject({ stopReason: "cancelled", finalText: "1\n2\n" });
    expect(r.usage).toMatchObject({ input: 40, output: 4 });
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("其它扩展的对话框取消、不代答；bash 交人被拒；模型报错 → agent_failed", async () => {
    const { peer, driver } = replay("foreign-dialog.jsonl");
    const session = await open(driver);
    const events: DriverEvent[] = [];
    const asked: DriverPermissionRequest[] = [];
    const error = await session
      .prompt(
        [{ type: "text", text: "clean up" }],
        hooks(events, async (req) => {
          asked.push(req);
          return { outcome: "selected", optionId: "reject" };
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "agent_failed" });
    expect(String((error as Error).message)).toContain("429 rate limited");
    expect(asked.map((a) => a.toolCall.title)).toEqual(["$ rm -rf build"]);
    expect(events.some((e) => e.type === "notice" && e.text.includes("Pick a preset"))).toBe(true);
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });
});
