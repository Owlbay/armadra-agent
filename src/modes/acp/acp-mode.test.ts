import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { emptyArgs } from "../../cli/args.js";
import type { Runtime } from "../../cli/runtime.js";
import { AcpClient } from "../../drivers/acp/client.js";
import type {
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpSessionNotification,
} from "../../drivers/acp/types.js";
import { golden, memoryTransport, type WireLine } from "../../drivers/test-support.js";
import { assertAcpWire } from "../../../test/helpers/acp-schema.js";
import { AgentSessionImpl } from "../../agent/session.js";
import { msg } from "../../i18n/index.js";
import type { ApprovalBroker } from "../../permissions/types.js";
import { AcpEventMapper } from "./acp-events.js";
import { runAcpMode } from "./acp-mode.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalize(wire: readonly WireLine[], root: string): string {
  return (
    wire
      .map((w) =>
        JSON.stringify(w, (key, value: unknown) => {
          if (key === "timestamp" || key === "durationMs") return 0;
          if (key === "version" && typeof value === "string") return "<version>";
          if (typeof value !== "string") return value;
          return value
            .replace(UUID, "<uuid>")
            .split(root)
            .join("<root>")
            .replace(/<root>[^\s"]*/g, (p) => p.replace(/\\/g, "/"));
        }),
      )
      .join("\n") + "\n"
  );
}

interface Harness {
  client: AcpClient;
  runtime: Runtime;
  updates: AcpSessionNotification[];
  wire: WireLine[];
  /** 绕过客户端直接写一行（id 用字符串，不与客户端的数字 id 冲突）。 */
  raw(message: Record<string, unknown>): void;
  /** ACP 模式挂上的 UI broker（直接喂审批请求用）。 */
  broker(): ApprovalBroker;
  /** 等 ama 对某个 id 的答复。 */
  answer(id: string): Promise<Record<string, unknown>>;
  /** 关闭客户端写端，等 ACP 模式退出；全部线上行过 schema 校验。 */
  finish(): Promise<number>;
}

async function start(
  script: FakeResponse[] | undefined,
  onPermission?: (
    p: AcpRequestPermissionParams,
    signal: AbortSignal,
  ) => Promise<AcpRequestPermissionResult>,
): Promise<Harness> {
  h = composeHarness(script);
  const runtime = await h.boot(["--mode", "rpc", "--model", "fake/echo"]);
  let exit!: Promise<number>;
  let broker: ApprovalBroker | undefined;
  const setUiBroker = runtime.approvals.setUiBroker.bind(runtime.approvals);
  runtime.approvals.setUiBroker = (b) => {
    broker ??= b;
    setUiBroker(b);
  };
  const mem = memoryTransport((input, output) => {
    exit = runAcpMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin: input, stdout: output },
    );
    return exit;
  });
  const updates: AcpSessionNotification[] = [];
  const client = new AcpClient({
    input: mem.transport.stdout,
    output: mem.transport.stdin,
    clientInfo: { name: "test", version: "0" },
    onUpdate: (n) => updates.push(n),
    ...(onPermission !== undefined ? { onPermission } : {}),
  });
  return {
    client,
    runtime,
    updates,
    wire: mem.wire,
    broker: () => broker!,
    raw(message) {
      mem.transport.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    },
    async answer(id) {
      for (;;) {
        const hit = mem.wire.find(
          (w) => w.dir === "out" && w.msg["id"] === id && !("method" in w.msg),
        );
        if (hit !== undefined) return hit.msg;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    async finish() {
      mem.transport.stdin.end();
      const code = await exit;
      await runtime.dispose();
      assertAcpWire(mem.wire);
      return code;
    },
  };
}

describe("ama --mode acp", () => {
  it("黄金记录：initialize → session/new → prompt → 更新与 end_turn；关 stdin 退出 0", async () => {
    const t = await start([{ text: "hello back", usage: { input: 10, output: 2 } }]);
    const init = await t.client.initialize();
    expect(init.agentCapabilities).toMatchObject({
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
      promptCapabilities: { image: true },
    });
    const created = await t.client.newSession(t.runtime.paths.cwd);
    expect(created.sessionId).toBe(t.runtime.session.state.sessionId);
    expect(created.modes?.currentModeId).toBe("default");
    const result = await t.client.prompt(created.sessionId, [{ type: "text", text: "hi" }]);
    expect(result).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const text = t.updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
    expect(text).toBe("hello back");
    expect(await t.finish()).toBe(0);
    {
      const text = normalize(t.wire, h.home.root);
      expect(text).toBe(golden("acp/mode-prompt.jsonl", text));
    }
  });

  it("审批经 session/request_permission 交给客户端：允许后执行", async () => {
    const requests: AcpRequestPermissionParams[] = [];
    const t = await start(
      [
        { steps: [{ toolCall: { name: "bash", arguments: { command: "echo acp-ok" } } }] },
        { text: "done" },
      ],
      async (p) => {
        requests.push(p);
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      },
    );
    await t.client.initialize();
    const { sessionId } = await t.client.newSession(t.runtime.paths.cwd);
    const result = await t.client.prompt(sessionId, [{ type: "text", text: "run" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sessionId,
      toolCall: {
        title: "bash: echo acp-ok",
        kind: "execute",
        rawInput: { command: "echo acp-ok" },
      },
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "allow_always", kind: "allow_always" },
        { optionId: "reject_once", kind: "reject_once" },
      ],
    });
    // 权限请求关联到模型发出的工具调用
    const call = t.updates.find((u) => u.update.sessionUpdate === "tool_call")?.update;
    expect(call).toMatchObject({ kind: "execute", status: "pending" });
    expect(requests[0]!.toolCall.toolCallId).toBe((call as { toolCallId: string }).toolCallId);
    const done = t.updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed");
    expect(JSON.stringify(done)).toContain("acp-ok");
    await t.finish();
  });

  it("客户端回 cancelled → ama 按无人作答拒绝；session/cancel 中断回合 → cancelled", async () => {
    const t = await start(
      [
        { steps: [{ toolCall: { name: "bash", arguments: { command: "echo no" } } }] },
        { text: "after deny" },
        { delayMs: 5_000, text: "too slow" },
      ],
      async () => ({ outcome: { outcome: "cancelled" } }),
    );
    await t.client.initialize();
    const { sessionId } = await t.client.newSession(t.runtime.paths.cwd);
    await t.client.prompt(sessionId, [{ type: "text", text: "run" }]);
    const failed = t.updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
    expect(failed).toBeDefined();
    const slow = t.client.prompt(sessionId, [{ type: "text", text: "slow" }]);
    await new Promise((r) => setTimeout(r, 50));
    await t.client.cancel(sessionId);
    await expect(slow).resolves.toMatchObject({ stopReason: "cancelled" });
    await t.finish();
  });

  it("set_mode → current_mode_update；未知模式 invalid params", async () => {
    const t = await start([]);
    await t.client.initialize();
    const { sessionId } = await t.client.newSession(t.runtime.paths.cwd);
    await t.client.setMode(sessionId, "plan");
    await new Promise((r) => setTimeout(r, 10));
    expect(t.updates.at(-1)?.update).toEqual({
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    });
    await expect(t.client.setMode(sessionId, "yolo")).rejects.toMatchObject({ code: -32602 });
    await t.finish();
  });

  it("session/new 换 cwd 被拒；list → load 回放 → resume 不回放；第二次 new 新开会话", async () => {
    const t = await start([{ text: "first answer" }, { text: "second" }]);
    await t.client.initialize();
    await expect(t.client.newSession("/elsewhere")).rejects.toMatchObject({ code: -32602 });
    const first = await t.client.newSession(t.runtime.paths.cwd);
    await t.client.prompt(first.sessionId, [{ type: "text", text: "remember" }]);
    const second = await t.client.newSession(t.runtime.paths.cwd);
    expect(second.sessionId).not.toBe(first.sessionId);
    await t.client.prompt(second.sessionId, [{ type: "text", text: "two" }]);
    const listed = await t.client.listSessions(t.runtime.paths.cwd);
    expect(listed.sessions.map((s) => s.sessionId)).toContain(first.sessionId);
    t.updates.length = 0;
    await t.client.loadSession(first.sessionId, t.runtime.paths.cwd);
    expect(t.updates.map((u) => u.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
    expect(t.updates.every((u) => u.sessionId === first.sessionId)).toBe(true);
    t.updates.length = 0;
    await t.client.resumeSession(second.sessionId, t.runtime.paths.cwd);
    expect(t.updates).toEqual([]);
    await expect(t.client.resumeSession("nope", t.runtime.paths.cwd)).rejects.toMatchObject({
      code: -32002,
    });
    await t.finish();
  });
});

describe("runCli 分派 --mode acp", () => {
  it("装配按 rpc，模式交给 runAcpMode", async () => {
    vi.resetModules();
    const seen: string[] = [];
    vi.doMock("./acp-mode.js", () => ({
      runAcpMode: async (runtime: Runtime) => {
        seen.push(runtime.mode);
        return 0;
      },
    }));
    const { runCli } = await import("../../cli/bootstrap.js");
    h = composeHarness([]);
    const code = await runCli(["--mode", "acp", "--model", "fake/echo"], h.deps(), h.io);
    vi.doUnmock("./acp-mode.js");
    expect(code).toBe(0);
    expect(seen).toEqual(["rpc"]);
  });
});

describe("ama --mode acp 多会话 [ACP-B]", () => {
  const text = (t: Harness, sessionId: string) =>
    t.updates
      .filter((u) => u.sessionId === sessionId)
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");

  it("复现：新建 s3（空）→ 回旧会话 prompt → 再对 s3 prompt，都成功（不再 -32002）", async () => {
    const t = await start([{ text: "one" }, { text: "back" }, { text: "three" }]);
    await t.client.initialize();
    const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    await t.client.prompt(s1, [{ type: "text", text: "first" }]);
    const s3 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    expect(s3).not.toBe(s1);
    await expect(t.client.prompt(s1, [{ type: "text", text: "b" }])).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    await expect(t.client.prompt(s3, [{ type: "text", text: "c" }])).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    expect(text(t, s1)).toBe("oneback");
    expect(text(t, s3)).toBe("three");
    expect(await t.finish()).toBe(0);
  });

  it("运行中 session/new + 对新会话 prompt → 排队；第一个结束后第二个开始，更新各归其位", async () => {
    const t = await start([{ delayMs: 300, text: "slow one" }, { text: "queued two" }]);
    await t.client.initialize();
    const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    const order: string[] = [];
    const p1 = t.client.prompt(s1, [{ type: "text", text: "1" }]).then((r) => {
      order.push("s1");
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    const s2 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    const p2 = t.client.prompt(s2, [{ type: "text", text: "2" }]).then((r) => {
      order.push("s2");
      return r;
    });
    await expect(t.client.listSessions(t.runtime.paths.cwd)).resolves.toBeDefined();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.stopReason).toBe("end_turn");
    expect(r2.stopReason).toBe("end_turn");
    expect(order).toEqual(["s1", "s2"]);
    expect(text(t, s1)).toBe("slow one");
    expect(text(t, s2)).toBe("queued two");
    // s2 的第一条更新在 s1 的最后一条之后
    const lastS1 = t.updates.findLastIndex((u) => u.sessionId === s1);
    const firstS2 = t.updates.findIndex((u) => u.sessionId === s2);
    expect(firstS2).toBeGreaterThan(lastS1);
    expect(t.wire.some((w) => (w.msg["error"] as { code?: number })?.code === -32600)).toBe(false);
    await t.finish();
  });

  it("排队中的 prompt 收到 session/cancel → 立即 cancelled，不调模型；在跑的照常结束", async () => {
    const t = await start([{ delayMs: 300, text: "running" }, { text: "after" }]);
    await t.client.initialize();
    const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    const s2 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    const p1 = t.client.prompt(s1, [{ type: "text", text: "1" }]);
    await new Promise((r) => setTimeout(r, 30));
    const p2 = t.client.prompt(s2, [{ type: "text", text: "2" }]);
    await new Promise((r) => setTimeout(r, 10));
    await t.client.cancel(s2);
    await expect(p2).resolves.toMatchObject({ stopReason: "cancelled", usage: { totalTokens: 0 } });
    await expect(p1).resolves.toMatchObject({ stopReason: "end_turn" });
    // 被取消的那条没有消耗脚本：s2 下一次拿到 "after"
    await t.client.prompt(s2, [{ type: "text", text: "3" }]);
    expect(text(t, s2)).toBe("after");
    await t.finish();
  });

  it("两会话不同 set_mode：非前台只记并通知，出队时重放到共享管线", async () => {
    const t = await start([{ text: "a" }, { text: "b" }]);
    await t.client.initialize();
    const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    const s2 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    expect((await t.client.resumeSession(s2, t.runtime.paths.cwd)).modes?.currentModeId).toBe(
      "default",
    );
    await t.client.setMode(s1, "plan");
    expect(t.runtime.permission.mode).toBe("plan");
    await t.client.setMode(s2, "auto-edit");
    // s2 不是前台：共享管线不动，但 s2 收到 current_mode_update
    expect(t.runtime.permission.mode).toBe("plan");
    await new Promise((r) => setTimeout(r, 10));
    const modeUpdates = () =>
      t.updates
        .filter((u) => u.update.sessionUpdate === "current_mode_update")
        .map((u) => [u.sessionId, (u.update as { currentModeId: string }).currentModeId]);
    expect(modeUpdates()).toEqual([
      [s1, "plan"],
      [s2, "auto-edit"],
    ]);
    await t.client.prompt(s2, [{ type: "text", text: "x" }]);
    expect(t.runtime.permission.mode).toBe("auto-edit");
    await t.client.prompt(s1, [{ type: "text", text: "y" }]);
    expect(t.runtime.permission.mode).toBe("plan");
    expect(modeUpdates()).toEqual([
      [s1, "plan"],
      [s2, "auto-edit"],
      [s2, "auto-edit"],
      [s1, "plan"],
    ]);
    expect((await t.client.resumeSession(s2, t.runtime.paths.cwd)).modes?.currentModeId).toBe(
      "auto-edit",
    );
    await t.finish();
  });

  it("close：运行中的回 cancelled；之后对该 id prompt / set_mode → -32002；关掉唯一会话后还能 new", async () => {
    const t = await start([{ delayMs: 2_000, text: "never" }, { text: "fresh" }]);
    await t.client.initialize();
    const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    const running = t.client.prompt(s1, [{ type: "text", text: "1" }]);
    await new Promise((r) => setTimeout(r, 30));
    await t.client.closeSession(s1);
    await expect(running).resolves.toMatchObject({ stopReason: "cancelled" });
    await expect(t.client.prompt(s1, [{ type: "text", text: "again" }])).rejects.toMatchObject({
      code: -32002,
    });
    await expect(t.client.setMode(s1, "plan")).rejects.toMatchObject({ code: -32002 });
    await expect(t.client.closeSession(s1)).resolves.toBeDefined();
    const s2 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    await expect(t.client.prompt(s2, [{ type: "text", text: "2" }])).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    expect(text(t, s2)).toBe("fresh");
    expect(await t.finish()).toBe(0);
  });

  it("session/list：别的 cwd → 空；非法 cursor → -32602；标题去掉嵌入资源块", async () => {
    const t = await start([{ text: "ok" }]);
    await t.client.initialize();
    const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    await t.client.prompt(s1, [
      {
        type: "resource",
        resource: { uri: "file:///a.ts", text: "const a = 1;\nconst b = 2;" },
      },
      { type: "text", text: "  explain   this file\nplease" },
    ]);
    const listed = await t.client.listSessions(t.runtime.paths.cwd);
    expect(listed.sessions).toEqual([
      expect.objectContaining({ sessionId: s1, title: "explain this file" }),
    ]);
    expect(listed.nextCursor).toBeUndefined();
    await expect(t.client.listSessions("/elsewhere")).resolves.toEqual({ sessions: [] });
    await expect(t.client.listSessions(undefined, "bogus")).rejects.toMatchObject({
      code: -32602,
    });
    await t.finish();
  });

  it("回合结束发 session_info_update（标题 + 时间）；配置项公布在开会话答复之后", async () => {
    const info = vi.spyOn(AcpEventMapper.prototype, "emitSessionInfo");
    const announce = vi.spyOn(AcpEventMapper.prototype, "announce");
    try {
      const t = await start([{ text: "ok" }]);
      await t.client.initialize();
      const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
      await new Promise((r) => setTimeout(r, 10));
      expect(announce).toHaveBeenCalledTimes(1);
      await t.client.prompt(s1, [{ type: "text", text: "name me" }]);
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0]![0]).toBe("name me");
      expect(Number.isNaN(Date.parse(info.mock.calls[0]![1]))).toBe(false);
      await t.client.loadSession(s1, t.runtime.paths.cwd);
      await new Promise((r) => setTimeout(r, 10));
      expect(announce).toHaveBeenCalledTimes(2);
      // set_config_option 接到配置项实现（C0 空实现：任何 id 都是 invalid params）；未知会话 -32002
      await expect(t.client.setConfigOption(s1, "nope", "x")).rejects.toMatchObject({
        code: -32602,
      });
      await expect(t.client.setConfigOption("missing", "model", "x")).rejects.toMatchObject({
        code: -32002,
      });
      await t.finish();
    } finally {
      info.mockRestore();
      announce.mockRestore();
    }
  });

  it("停止原因：拒答 → refusal；回合抛错时已请求取消 → cancelled，否则 -32603", async () => {
    const t = await start([{ text: "no", stopReason: "refusal" }]);
    await t.client.initialize();
    const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    await expect(t.client.prompt(s1, [{ type: "text", text: "x" }])).resolves.toMatchObject({
      stopReason: "refusal",
    });
    const session = t.runtime.session as AgentSessionImpl;
    const original = session.prompt.bind(session);
    session.prompt = async () => {
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("boom");
    };
    const cancelled = t.client.prompt(s1, [{ type: "text", text: "y" }]);
    await new Promise((r) => setTimeout(r, 10));
    await t.client.cancel(s1);
    await expect(cancelled).resolves.toMatchObject({ stopReason: "cancelled" });
    await expect(t.client.prompt(s1, [{ type: "text", text: "z" }])).rejects.toMatchObject({
      code: -32603,
      message: "boom",
    });
    session.prompt = original;
    await t.finish();
  });

  it("$/cancel_request 撤回 prompt → -32800；mcpServers / additionalDirectories 忽略并在 stderr 说一行", async () => {
    const t = await start([{ delayMs: 2_000, text: "slow" }]);
    await t.client.initialize();
    t.raw({
      id: "new-1",
      method: "session/new",
      params: {
        cwd: t.runtime.paths.cwd,
        mcpServers: [{ name: "x", command: "/bin/true", args: [], env: [] }],
        additionalDirectories: ["/tmp"],
      },
    });
    const created = await t.answer("new-1");
    const sessionId = (created["result"] as { sessionId: string }).sessionId;
    const notes = h
      .stderr()
      .split("\n")
      .filter((l) => l.startsWith("ama: ACP"));
    // 各一行：MCP 服务器、附加目录（文案随界面语言）
    expect(notes).toEqual(
      [msg().acp.session.ignoredMcp(1), msg().acp.session.ignoredDirs(1)].map((m) => `ama: ${m}`),
    );
    t.raw({
      id: "prompt-1",
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "go" }] },
    });
    await new Promise((r) => setTimeout(r, 50));
    t.raw({ method: "$/cancel_request", params: { requestId: "prompt-1" } });
    const answer = await t.answer("prompt-1");
    expect(answer["error"]).toMatchObject({ code: -32800 });
    await t.finish();
  });

  it("stdin 关闭：排队的回 cancelled，在跑的跑完，兄弟会话全部释放", async () => {
    const dispose = vi.spyOn(AgentSessionImpl.prototype, "dispose");
    try {
      const t = await start([{ delayMs: 200, text: "one" }, { text: "two" }]);
      await t.client.initialize();
      const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
      const s2 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
      const s3 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
      const p1 = t.client.prompt(s1, [{ type: "text", text: "1" }]);
      await new Promise((r) => setTimeout(r, 20));
      const p2 = t.client.prompt(s2, [{ type: "text", text: "2" }]);
      await new Promise((r) => setTimeout(r, 10));
      const code = t.finish();
      await expect(p1).resolves.toMatchObject({ stopReason: "end_turn" });
      await expect(p2).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(await code).toBe(0);
      expect(s3).toBeDefined();
      // s2、s3 由服务端释放，前台 s1 由 Runtime.dispose 释放
      expect(dispose.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      dispose.mockRestore();
    }
  });

  it("审批的 toolCallId：本会话用 context.toolCallId；子 Agent（depth > 0）的退回 requestId", async () => {
    const seen: string[] = [];
    const t = await start([{ delayMs: 300, text: "busy" }], async (p) => {
      seen.push(p.toolCall.toolCallId);
      return { outcome: { outcome: "selected", optionId: "reject_once" } };
    });
    await t.client.initialize();
    const s1 = (await t.client.newSession(t.runtime.paths.cwd)).sessionId;
    const running = t.client.prompt(s1, [{ type: "text", text: "1" }]);
    await new Promise((r) => setTimeout(r, 30));
    const signal = new AbortController().signal;
    const base = { toolName: "bash", input: { command: "ls" }, reason: "mode" as const };
    await expect(
      t
        .broker()
        .ask({ ...base, requestId: "r1", context: { depth: 0, toolCallId: "c1_n1" } }, signal),
    ).resolves.toBe("deny");
    await t
      .broker()
      .ask(
        { ...base, requestId: "r2", context: { depth: 1, taskId: "t1", toolCallId: "sub" } },
        signal,
      );
    expect(seen).toEqual(["c1_n1", "r2"]);
    await running;
    await t.finish();
  });
});
