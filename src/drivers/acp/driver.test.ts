import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { assertAcpWire } from "../../../test/helpers/acp-schema.js";
import { JsonRpcPeer, RpcError } from "../jsonrpc.js";
import type { ProgramProbe } from "../probe.js";
import { spawnTransport } from "../process.js";
import { golden, memoryTransport, spawnRecorder, wireText } from "../test-support.js";
import type {
  DriverEvent,
  DriverPermissionOutcome,
  DriverPermissionRequest,
  DriverSession,
} from "../types.js";
import { runFakeAcpAgent, type FakeAcpAgentOptions } from "./testing/fake-agent.js";
import {
  AcpDriver,
  acpTurnUsage,
  pickConfigModeValue,
  pickModeId,
  pickModelValue,
} from "./driver.js";
import { catalogEntry } from "../catalog.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../../permissions/types.js";
import { ACP_METHODS, RPC_ERRORS, type AcpSessionUpdate } from "./types.js";

const CWD = "/work";
const candidate = { kind: "acp" as const, program: "fake-acp", args: [] };

function fakeDriver(options: FakeAcpAgentOptions = {}) {
  const rec = spawnRecorder(() =>
    memoryTransport((input, output) => runFakeAcpAgent(input, output, options)),
  );
  const driver = new AcpDriver("acp:fake-acp", candidate, { spawn: rec.spawn, cancelGraceMs: 50 });
  return { driver, rec };
}

const open = (
  driver: AcpDriver,
  extra: { resume?: string; mode?: "plan" | "default"; model?: string } = {},
) =>
  driver.open({
    cwd: CWD,
    mode: extra.mode ?? "default",
    env: {},
    signal: new AbortController().signal,
    ...(extra.resume !== undefined ? { resume: extra.resume } : {}),
    ...(extra.model !== undefined ? { model: extra.model } : {}),
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
      assertAcpWire(wire);
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
      assertAcpWire(wire);
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
      assertAcpWire(wire);
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

describe("[W5-Z] 启动路径", () => {
  it("用探测到的完整路径启动（Windows 的 .cmd 垫片要靠扩展名改走 cmd.exe）", async () => {
    const rec = spawnRecorder(() =>
      memoryTransport((input, output) => runFakeAcpAgent(input, output)),
    );
    const located = { path: "C:\\npm\\fake-acp.cmd", version: "1.0.0" };
    const probe = { locate: async () => located, capture: async () => undefined };
    const driver = new AcpDriver("acp:fake-acp", candidate, {
      spawn: rec.spawn,
      probe: probe as unknown as ProgramProbe,
    });
    sessions.push(await open(driver));
    expect(rec.specs[0]?.program).toBe(located.path);
  });

  it("没有探测器时退回程序名", async () => {
    const { driver, rec } = fakeDriver();
    sessions.push(await open(driver));
    expect(rec.specs[0]?.program).toBe("fake-acp");
  });
});

/**
 * 只为本文件写的迷你 Agent：`session/prompt` 按脚本发 `session/update`，然后要么回 stopReason，
 * 要么等 `session/cancel` 后回 -32800（有的 Agent 这样答被取消的回合）。
 */
function scriptedAgent(script: {
  updates?: AcpSessionUpdate[];
  /** 等 session/cancel，然后回 -32800。 */
  cancelWith32800?: boolean;
  /** 不等取消，直接回 -32800。 */
  error32800?: boolean;
}) {
  return (input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> => {
    let cancelled: (() => void) | undefined;
    const peer: JsonRpcPeer = new JsonRpcPeer({
      input,
      output,
      cancelRequests: true,
      onNotification(method) {
        if (method === ACP_METHODS.sessionCancel) cancelled?.();
      },
      async onRequest(method, raw) {
        const params = (raw ?? {}) as Record<string, unknown>;
        switch (method) {
          case ACP_METHODS.initialize:
            return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
          case ACP_METHODS.sessionNew:
            return { sessionId: "m-1" };
          case ACP_METHODS.sessionPrompt: {
            for (const update of script.updates ?? [])
              await peer.notify(ACP_METHODS.sessionUpdate, {
                sessionId: params["sessionId"],
                update,
              });
            if (script.error32800)
              throw new RpcError(RPC_ERRORS.requestCancelled, "request cancelled");
            if (script.cancelWith32800) {
              await new Promise<void>((resolve) => (cancelled = resolve));
              throw new RpcError(RPC_ERRORS.requestCancelled, "request cancelled");
            }
            return { stopReason: "end_turn" };
          }
          default:
            throw new RpcError(RPC_ERRORS.methodNotFound, method);
        }
      },
    });
    return peer.closed;
  };
}

function scriptedDriver(script: Parameters<typeof scriptedAgent>[0]) {
  const rec = spawnRecorder(() => memoryTransport(scriptedAgent(script)));
  return {
    driver: new AcpDriver("acp:mini", candidate, { spawn: rec.spawn, cancelGraceMs: 50 }),
    rec,
  };
}

const noPermission = async (): Promise<DriverPermissionOutcome> => ({ outcome: "cancelled" });

describe("[ACP-D] 客户端侧", () => {
  it("--config-only：没有 modes 时 plan 经 session/set_config_option 设置", async () => {
    const { driver, rec } = fakeDriver({ configOnly: true });
    sessions.push(await open(driver, { mode: "plan" }));
    const wire = rec.last()!.wire;
    expect(wire.some((w) => w.msg["method"] === "session/set_mode")).toBe(false);
    expect(
      wire.find((w) => w.msg["method"] === "session/set_config_option")?.msg["params"],
    ).toMatchObject({ configId: "mode", value: "plan" });
    assertAcpWire(wire);
  });

  it("--config-only：当前值已是要的模式时不发 set_config_option", async () => {
    const { driver, rec } = fakeDriver({ configOnly: true });
    sessions.push(await open(driver, { mode: "default" }));
    expect(rec.last()!.wire.some((w) => w.msg["method"] === "session/set_config_option")).toBe(
      false,
    );
  });

  it("mode 类配置项的分组值也能匹配；没有匹配返回 undefined", () => {
    const option = {
      id: "m",
      name: "M",
      category: "mode",
      type: "select",
      currentValue: "ask",
      options: [{ group: "g", name: "G", options: [{ value: "plan", name: "Plan" }] }],
    };
    expect(pickConfigModeValue("plan", candidate, option)).toBe("plan");
    expect(pickConfigModeValue("allowlist", candidate, option)).toBe("plan");
    expect(pickConfigModeValue("auto", candidate, option)).toBeUndefined();
  });

  it("[#198] 模型：按 category model 的配置项设置（值、名称不分大小写）；没有时提示用缺省", async () => {
    const { driver, rec } = fakeDriver({ configOptions: true });
    sessions.push(await open(driver, { model: "Large" }));
    expect(
      rec.last()!.wire.find((w) => w.msg["method"] === "session/set_config_option")?.msg["params"],
    ).toMatchObject({ configId: "model", value: "large" });
    assertAcpWire(rec.last()!.wire);
    const other = fakeDriver({ configOptions: true });
    const session = await open(other.driver, { model: "nope" });
    sessions.push(session);
    expect(
      other.rec.last()!.wire.some((w) => w.msg["method"] === "session/set_config_option"),
    ).toBe(false);
    const events: DriverEvent[] = [];
    await session.prompt([{ type: "text", text: "hi" }], {
      onEvent: (e) => events.push(e),
      onPermission: noPermission,
    });
    expect(events.some((e) => e.type === "notice" && e.text.includes("nope"))).toBe(true);
  });

  it("[#198] provider/model 形式的值按模型部分匹配", () => {
    const option = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "a/x",
      options: [
        { value: "a/x", name: "X" },
        { value: "opencode/free-1", name: "Free" },
      ],
    };
    expect(pickModelValue("free-1", [option])).toEqual({
      configId: "model",
      value: "opencode/free-1",
      current: false,
    });
    expect(pickModelValue("a/x", [option])?.current).toBe(true);
    expect(pickModelValue("x", undefined)).toBeUndefined();
  });

  it("[#198] 用量：totalTokens = input + output 时 input 含缓存；会话累计的按差值", () => {
    // Copilot 1.0.95 实测（两轮，会话累计，input 含缓存）
    const t1 = {
      inputTokens: 25301,
      outputTokens: 85,
      totalTokens: 25386,
      cachedReadTokens: 7680,
    };
    const t2 = {
      inputTokens: 50645,
      outputTokens: 172,
      totalTokens: 50817,
      cachedReadTokens: 32896,
    };
    expect(acpTurnUsage(t1, {})).toEqual({ input: 17621, output: 85, cacheRead: 7680 });
    expect(acpTurnUsage(t2, t1)).toEqual({ input: 128, output: 87, cacheRead: 25216 });
    // codex-acp / claude-agent-acp：本回合、input 不含缓存
    expect(acpTurnUsage({ inputTokens: 199, outputTokens: 5, cachedReadTokens: 26368 })).toEqual({
      input: 199,
      output: 5,
      cacheRead: 26368,
    });
  });

  it("[#198] 实测的模式表：每个 ama 模式都有映射，且从不落到放开全部权限的模式", () => {
    const states = {
      "claude-agent-acp": ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
      "codex-acp": ["read-only", "workspace-write", "agent", "agent-full-access"],
      copilot: ["agent", "plan", "autopilot"].map(
        (m) => `https://agentclientprotocol.com/protocol/session-modes#${m}`,
      ),
    };
    const loose = /bypassPermissions|full-access|autopilot/;
    for (const [program, ids] of Object.entries(states)) {
      const c = ["claude", "codex", "copilot"]
        .flatMap((id) => catalogEntry(id)!.candidates)
        .find((x) => x.program === program)!;
      const state = {
        currentModeId: ids.at(-1)!,
        availableModes: ids.map((id) => ({ id, name: id })),
      };
      for (const mode of PERMISSION_MODES_STRICT_FIRST) {
        const picked = pickModeId(mode, c, state);
        expect(picked, `${program} ${mode}`).toBeDefined();
        expect(picked).not.toMatch(loose);
      }
    }
  });

  it("--auth-required：开会话 -32000 → agent_auth_required，文案列出方法与终端命令", async () => {
    const { driver } = fakeDriver({ authRequired: true });
    const error = await open(driver).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "agent_auth_required" });
    const message = (error as Error).message;
    expect(message).toContain("acp:fake-acp");
    expect(message).toContain("Log in");
    expect(message).toContain("fake-acp --login");
  });

  it("[cancel-request]：Agent 撤回权限请求 → 审批的 signal abort、回 cancelled，回合正常结束", async () => {
    const { driver, rec } = fakeDriver({ cancelRequestMs: 30 });
    const session = await open(driver);
    sessions.push(session);
    let seen: AbortSignal | undefined;
    const result = await session.prompt([{ type: "text", text: "[cancel-request]" }], {
      onEvent: () => undefined,
      onPermission: (_req, signal) =>
        new Promise((resolve) => {
          seen = signal;
          signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }));
        }),
    });
    expect(seen?.aborted).toBe(true);
    expect(result).toMatchObject({
      stopReason: "end_turn",
      finalText: "permission withdrawn",
      toolSummary: ["✗ edit Write note.txt"],
      filesTouched: [],
    });
    const wire = rec.last()!.wire;
    const ask = wire.find((w) => w.msg["method"] === "session/request_permission")!;
    expect(wire.find((w) => w.msg["method"] === "$/cancel_request")?.msg["params"]).toEqual({
      requestId: ask.msg["id"],
    });
    // 撤回后客户端仍答 cancelled（规范允许答结果或 -32800）
    expect(
      wire.find((w) => w.dir === "in" && w.msg["id"] === ask.msg["id"] && "result" in w.msg)?.msg[
        "result"
      ],
    ).toEqual({ outcome: { outcome: "cancelled" } });
    assertAcpWire(wire);
  });

  it("取消回合后 session/prompt 回 -32800 → cancelled", async () => {
    const { driver } = scriptedDriver({ cancelWith32800: true });
    const session = await open(driver);
    sessions.push(session);
    const pending = session.prompt([{ type: "text", text: "go" }], {
      onEvent: () => undefined,
      onPermission: noPermission,
    });
    await new Promise((r) => setTimeout(r, 10));
    await session.cancel();
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
  });

  it("没取消时的 -32800 照常报错", async () => {
    const { driver } = scriptedDriver({ error32800: true });
    const session = await open(driver);
    sessions.push(session);
    await expect(
      session.prompt([{ type: "text", text: "go" }], {
        onEvent: () => undefined,
        onPermission: noPermission,
      }),
    ).rejects.toMatchObject({ code: RPC_ERRORS.requestCancelled });
  });

  it("diff 内容的 path 并入 locations 与 filesTouched（不论工具种类）", async () => {
    const { driver } = scriptedDriver({
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "t1", title: "Patch", kind: "other" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [
            { type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" },
            { type: "content", content: { type: "text", text: "ok" } },
          ],
        },
        { sessionUpdate: "tool_call", toolCallId: "t2", title: "Failed", kind: "other" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t2",
          status: "failed",
          content: [{ type: "diff", path: "/work/b.ts", oldText: null, newText: "x" }],
        },
      ],
    });
    const session = await open(driver);
    sessions.push(session);
    const events: DriverEvent[] = [];
    const result = await session.prompt([{ type: "text", text: "go" }], {
      onEvent: (e) => events.push(e),
      onPermission: noPermission,
    });
    expect(result.filesTouched).toEqual(["/work/a.ts"]);
    expect(events.find((e) => e.type === "tool_call" && e.status === "completed")).toMatchObject({
      locations: ["/work/a.ts"],
    });
  });
});
