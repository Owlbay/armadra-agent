import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { composeHarness } from "../../../test/helpers/compose-harness.js";
import { JsonRpcPeer } from "../../drivers/jsonrpc.js";
import { clientCapabilitiesOf, createAcpConnection } from "./acp-connection.js";

describe("[ACP-C0] createAcpConnection", () => {
  it("请求 / 通知转给 handlers；initialize 前后的协商状态；客户端撤回请求 → -32800", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const notes: unknown[] = [];
    const logs: string[] = [];
    const connection = createAcpConnection(
      { input: toAgent, output: fromAgent },
      logs.push.bind(logs),
      {
        async onRequest(method, params, ctx) {
          if (method === "initialize") {
            connection.markInitialized(clientCapabilitiesOf(params as Record<string, unknown>));
            return { ok: true };
          }
          await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
          throw new Error("stopped");
        },
        onNotification: (method, params) => notes.push([method, params]),
      },
    );
    expect(connection.initialized).toBe(false);
    expect(connection.clientCapabilities).toEqual({});
    const client = new JsonRpcPeer({ input: fromAgent, output: toAgent, cancelRequests: true });
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });
    expect(connection.initialized).toBe(true);
    expect(connection.clientCapabilities).toEqual({ auth: { terminal: true } });
    await client.notify("session/cancel", { sessionId: "s" });
    const controller = new AbortController();
    const slow = client.request("session/prompt", {}, controller.signal);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(slow).rejects.toThrow(/aborted/);
    toAgent.write("oops\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(notes).toEqual([["session/cancel", { sessionId: "s" }]]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("invalid JSON");
    toAgent.end();
    await connection.peer.closed;
  });

  it("clientCapabilitiesOf：缺省或不是对象 → 空对象", () => {
    expect(clientCapabilitiesOf({})).toEqual({});
    expect(clientCapabilitiesOf({ clientCapabilities: null })).toEqual({});
    expect(clientCapabilitiesOf({ clientCapabilities: { terminal: true } })).toEqual({
      terminal: true,
    });
  });
});

describe("[ACP-A] runCli：--mode acp 没有可用模型交给认证门", () => {
  it("认证门收到原错误（NoModel），退出码取认证门的；其它模式不经认证门", async () => {
    vi.resetModules();
    const seen: unknown[] = [];
    vi.doMock("./acp-auth-gate.js", () => ({
      runAcpAuthGate: (...args: unknown[]) => {
        seen.push(args[3]);
        return Promise.resolve(0);
      },
    }));
    const { runCli } = await import("../../cli/bootstrap.js");
    const h = composeHarness([]);
    try {
      expect(await runCli(["--mode", "acp"], h.deps(), h.io)).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ exitCode: 4 });
      // 其它模式不经认证门，照旧退出码 4
      expect(await runCli(["--mode", "rpc"], h.deps(), h.io)).toBe(4);
      expect(seen).toHaveLength(1);
      expect(h.stderr()).not.toBe("");
    } finally {
      vi.doUnmock("./acp-auth-gate.js");
      h.cleanup();
    }
  });
});
