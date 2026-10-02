import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ACP_METHODS } from "./acp/types.js";
import { runFakeAcpAgent } from "./acp/testing/fake-agent.js";
import { JsonRpcPeer, RpcError } from "./jsonrpc.js";

function pair(options: { aField?: boolean } = {}) {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const wireA: string[] = [];
  ab.on("data", (c: Buffer) => wireA.push(...c.toString("utf8").split("\n").filter(Boolean)));
  const a = new JsonRpcPeer({ input: ba, output: ab, jsonrpcField: options.aField ?? true });
  return { a, ab, ba, wireA };
}

describe("JsonRpcPeer", () => {
  it("请求 / 响应 / 通知 / 错误往返", async () => {
    const { a, ab, ba } = pair();
    const notes: unknown[] = [];
    const b = new JsonRpcPeer({
      input: ab,
      output: ba,
      async onRequest(method, params) {
        if (method === "add") {
          const p = params as { x: number; y: number };
          return { sum: p.x + p.y };
        }
        throw new RpcError(-32601, `no ${method}`);
      },
      onNotification: (method, params) => notes.push([method, params]),
    });
    await expect(a.request("add", { x: 1, y: 2 })).resolves.toEqual({ sum: 3 });
    await expect(a.request("nope")).rejects.toMatchObject({ code: -32601, message: "no nope" });
    await a.notify("ping", { n: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(notes).toEqual([["ping", { n: 1 }]]);
    ab.end();
    await b.closed;
  });

  it("不写 jsonrpc 字段（Codex app-server 形状）", async () => {
    const { a, wireA } = pair({ aField: false });
    void a.notify("initialized");
    await a.flush();
    expect(JSON.parse(wireA[0] ?? "{}")).toEqual({ method: "initialized" });
  });

  it("对端关闭：挂起请求以 connection closed 失败；signal abort 不再等", async () => {
    const { a, ba } = pair();
    const pending = a.request("slow");
    const controller = new AbortController();
    const aborted = a.request("slow2", undefined, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/);
    ba.end();
    await expect(pending).rejects.toMatchObject({ data: { reason: "connection_closed" } });
    expect(a.isOpen).toBe(false);
    await expect(a.request("after")).rejects.toThrow(/connection closed/);
  });

  it("坏行只报协议错误，不断开", async () => {
    const ab = new PassThrough();
    const ba = new PassThrough();
    const errors: string[] = [];
    const a = new JsonRpcPeer({
      input: ba,
      output: ab,
      onProtocolError: (_line, reason) => errors.push(reason),
    });
    ba.write("not json\n");
    ba.write('{"result":1}\n');
    const p = a.request("x");
    ba.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    await expect(p).resolves.toEqual({ ok: true });
    expect(errors).toEqual(["invalid JSON", "response without id"]);
  });
});

describe("假 ACP Agent", () => {
  it("initialize → session/new → prompt 回 echo 与 usage", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const done = runFakeAcpAgent(toAgent, fromAgent);
    const updates: unknown[] = [];
    const client = new JsonRpcPeer({
      input: fromAgent,
      output: toAgent,
      onNotification: (_m, p) => updates.push((p as { update: unknown }).update),
    });
    const init = await client.request<{ agentCapabilities: { loadSession: boolean } }>(
      ACP_METHODS.initialize,
      { protocolVersion: 1, clientCapabilities: {} },
    );
    expect(init.agentCapabilities.loadSession).toBe(true);
    const { sessionId } = await client.request<{ sessionId: string }>(ACP_METHODS.sessionNew, {
      cwd: "/w",
      mcpServers: [],
    });
    expect(sessionId).toBe("fake-1");
    const result = await client.request(ACP_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(result).toMatchObject({ stopReason: "end_turn" });
    expect(updates[0]).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "echo: hi" },
    });
    toAgent.end();
    await done;
  });
});
