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
  /** 关闭客户端写端，等 ACP 模式退出。 */
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
    async finish() {
      mem.transport.stdin.end();
      const code = await exit;
      await runtime.dispose();
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
    golden("acp/mode-prompt.jsonl", normalize(t.wire, h.home.root));
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
