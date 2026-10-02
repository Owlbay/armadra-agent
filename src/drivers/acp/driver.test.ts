import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { spawnTransport } from "../process.js";
import { golden, memoryTransport, spawnRecorder, wireText } from "../test-support.js";
import type {
  DriverEvent,
  DriverPermissionOutcome,
  DriverPermissionRequest,
  DriverSession,
} from "../types.js";
import { runFakeAcpAgent } from "./testing/fake-agent.js";
import { AcpDriver } from "./driver.js";

const CWD = "/work";
const candidate = { kind: "acp" as const, program: "fake-acp", args: [] };

function fakeDriver(options: { minimal?: boolean } = {}) {
  const rec = spawnRecorder(() =>
    memoryTransport((input, output) => runFakeAcpAgent(input, output, options)),
  );
  const driver = new AcpDriver("acp:fake-acp", candidate, { spawn: rec.spawn, cancelGraceMs: 50 });
  return { driver, rec };
}

const open = (driver: AcpDriver, extra: { resume?: string; mode?: "plan" | "default" } = {}) =>
  driver.open({
    cwd: CWD,
    mode: extra.mode ?? "default",
    env: {},
    signal: new AbortController().signal,
    ...(extra.resume !== undefined ? { resume: extra.resume } : {}),
  });

let sessions: DriverSession[] = [];
afterEach(async () => {
  for (const s of sessions) await s.close();
  sessions = [];
});

async function runPermission(
  answer: (
    req: DriverPermissionRequest,
    signal: AbortSignal,
    s: DriverSession,
  ) => Promise<DriverPermissionOutcome>,
) {
  const { driver, rec } = fakeDriver();
  const session = await open(driver);
  sessions.push(session);
  const events: DriverEvent[] = [];
  const requests: DriverPermissionRequest[] = [];
  const result = await session.prompt([{ type: "text", text: "[permission] write it" }], {
    onEvent: (e) => events.push(e),
    onPermission: (req, signal) => {
      requests.push(req);
      return answer(req, signal, session);
    },
  });
  return { result, events, requests, wire: rec.last()!.wire };
}

describe("AcpDriver × 假 ACP Agent（黄金记录）", () => {
  it("允许：选首个 allow_once，工具完成，文件计入 filesTouched", async () => {
    const { result, requests, wire } = await runPermission(async (req) => ({
      outcome: "selected",
      optionId: req.options.find((o) => o.kind === "allow_once")!.optionId,
    }));
    expect(requests[0]).toMatchObject({
      toolCall: { title: "Write note.txt", kind: "edit", locations: ["/work/note.txt"] },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "always", kind: "allow_always" },
        { optionId: "reject", kind: "reject_once" },
        { optionId: "never", kind: "reject_always" },
      ],
    });
    expect(result).toMatchObject({
      stopReason: "end_turn",
      finalText: "wrote note.txt",
      filesTouched: ["/work/note.txt"],
      toolSummary: ["✓ edit Write note.txt"],
      usage: { input: 10, output: 5 },
    });
    {
      const text = wireText(wire);
      expect(text).toBe(golden("acp/driver-allow.jsonl", text));
    }
  });

  it("拒绝：reject_once，工具失败，无文件", async () => {
    const { result, wire } = await runPermission(async () => ({
      outcome: "selected",
      optionId: "reject",
    }));
    expect(result).toMatchObject({
      stopReason: "end_turn",
      finalText: "write rejected",
      filesTouched: [],
      toolSummary: ["✗ edit Write note.txt"],
    });
    {
      const text = wireText(wire);
      expect(text).toBe(golden("acp/driver-reject.jsonl", text));
    }
  });

  it("取消：审批挂起时 cancel → 请求回 cancelled，回合 cancelled", async () => {
    const { result, wire } = await runPermission(
      (_req, signal, session) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }));
          void session.cancel();
        }),
    );
    expect(result.stopReason).toBe("cancelled");
    const response = wire.find((w) => w.dir === "in" && w.msg["id"] === 1 && "result" in w.msg);
    expect(response?.msg["result"]).toEqual({ outcome: { outcome: "cancelled" } });
    {
      const text = wireText(wire);
      expect(text).toBe(golden("acp/driver-cancel.jsonl", text));
    }
  });

  it("close() 时挂起的审批回 cancelled（父 abort 路径）", async () => {
    const { driver } = fakeDriver();
    const session = await open(driver);
    let seen: AbortSignal | undefined;
    const prompt = session.prompt([{ type: "text", text: "[permission]" }], {
      onEvent: () => undefined,
      onPermission: (_req, signal) =>
        new Promise((resolve) => {
          seen = signal;
          signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }));
          void session.close();
        }),
    });
    await expect(prompt).rejects.toThrow();
    expect(seen?.aborted).toBe(true);
  });

  it("[slow] 回合：cancel 后假 Agent 以 cancelled 结束", async () => {
    const { driver } = fakeDriver();
    const session = await open(driver);
    sessions.push(session);
    const p = session.prompt([{ type: "text", text: "[slow]" }], {
      onEvent: () => undefined,
      onPermission: async () => ({ outcome: "cancelled" }),
    });
    await new Promise((r) => setTimeout(r, 10));
    await session.cancel();
    await expect(p).resolves.toMatchObject({ stopReason: "cancelled" });
  });

  it("续接优先 session/resume；不支持时新开并提示", async () => {
    const { driver, rec } = fakeDriver();
    const s1 = await open(driver, { resume: "fake-9" });
    sessions.push(s1);
    expect(s1.sessionId).toBe("fake-9");
    expect(rec.last()!.wire.some((w) => w.msg["method"] === "session/resume")).toBe(true);

    const minimal = fakeDriver({ minimal: true });
    const s2 = await open(minimal.driver, { resume: "fake-9" });
    sessions.push(s2);
    expect(s2.sessionId).toBe("fake-1");
    const events: DriverEvent[] = [];
    await s2.prompt([{ type: "text", text: "hi" }], {
      onEvent: (e) => events.push(e),
      onPermission: async () => ({ outcome: "cancelled" }),
    });
    expect(events[0]).toMatchObject({ type: "notice", text: expect.stringContaining("已新开") });
  });

  it("模式：plan 映射到 set_mode；Agent 没有只读模式时拒绝启动", async () => {
    const { driver, rec } = fakeDriver();
    sessions.push(await open(driver, { mode: "plan" }));
    expect(rec.last()!.wire.find((w) => w.msg["method"] === "session/set_mode")?.msg).toMatchObject(
      { params: { modeId: "plan" } },
    );
    const minimal = fakeDriver({ minimal: true });
    await expect(open(minimal.driver, { mode: "plan" })).rejects.toMatchObject({
      code: "agent_mode_unsupported",
    });
  });

  it("思考、计划与用量事件归一化", async () => {
    const { driver } = fakeDriver();
    const session = await open(driver);
    sessions.push(session);
    const events: DriverEvent[] = [];
    await session.prompt([{ type: "text", text: "[think][plan] go" }], {
      onEvent: (e) => events.push(e),
      onPermission: async () => ({ outcome: "cancelled" }),
    });
    expect(events.map((e) => e.type)).toEqual(["thought_delta", "plan", "message_delta", "usage"]);
    expect(events[3]).toEqual({
      type: "usage",
      contextTokens: 15,
      contextWindow: 1000,
      costUsd: 0.001,
    });
  });
});

describe("AcpDriver × 真实子进程（假 Agent 打包成单文件）", () => {
  it("spawn → echo → close 回收进程", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ama-fake-acp-")));
    const outfile = join(dir, "fake-agent.cjs");
    buildSync({
      entryPoints: [fileURLToPath(new URL("./testing/fake-agent-main.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      logLevel: "warning",
    });
    let exited: Promise<number | null> | undefined;
    const driver = new AcpDriver(
      "acp:fake",
      { kind: "acp", program: process.execPath, args: [outfile] },
      {
        spawn: (spec) => {
          const t = spawnTransport(spec);
          exited = t.exited;
          return t;
        },
      },
    );
    const session = await driver.open({
      cwd: dir,
      mode: "default",
      env: { PATH: process.env["PATH"] ?? "" },
      signal: new AbortController().signal,
    });
    const result = await session.prompt([{ type: "text", text: "real" }], {
      onEvent: () => undefined,
      onPermission: async () => ({ outcome: "cancelled" }),
    });
    expect(result.finalText).toBe("echo: real");
    await session.close();
    await expect(exited).resolves.toBe(0);
  });
});
