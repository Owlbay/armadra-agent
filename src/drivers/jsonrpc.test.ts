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

describe("$/cancel_request（cancelRequests）", () => {
  /** a ↔ b 两端；返回双方写出的行。 */
  function peers(cancelRequests: boolean | undefined, jsonrpcField = true) {
    const ab = new PassThrough();
    const ba = new PassThrough();
    const wireA: Record<string, unknown>[] = [];
    const wireB: Record<string, unknown>[] = [];
    const tap = (stream: PassThrough, into: Record<string, unknown>[]) =>
      stream.on("data", (c: Buffer) =>
        into.push(
          ...c
            .toString("utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>),
        ),
      );
    tap(ab, wireA);
    tap(ba, wireB);
    const seen: { signal?: AbortSignal; notes: unknown[] } = { notes: [] };
    const options = cancelRequests === undefined ? {} : { cancelRequests };
    const a = new JsonRpcPeer({ input: ba, output: ab, jsonrpcField, ...options });
    const b = new JsonRpcPeer({
      input: ab,
      output: ba,
      jsonrpcField,
      ...options,
      onNotification: (method, params) => seen.notes.push([method, params]),
      async onRequest(method, _params, ctx) {
        seen.signal = ctx.signal;
        if (method === "quick") return { ok: true };
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) return resolve();
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 300);
        });
        throw new Error("handler gave up");
      },
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    return { a, b, ab, ba, wireA, wireB, seen, settle };
  }

  it("出站：signal abort 时给对端发 $/cancel_request，本端仍以 aborted 拒绝", async () => {
    const { a, wireA, settle } = peers(true);
    const controller = new AbortController();
    const pending = a.request("slow", { n: 1 }, controller.signal);
    await settle();
    controller.abort();
    await expect(pending).rejects.toThrow(/slow: aborted/);
    await a.flush();
    expect(wireA).toEqual([
      { jsonrpc: "2.0", id: 1, method: "slow", params: { n: 1 } },
      { jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 1 } },
    ]);
  });

  it("出站：发出前就 abort 的请求不发任何行", async () => {
    const { a, wireA } = peers(true);
    const controller = new AbortController();
    controller.abort();
    await expect(a.request("never", undefined, controller.signal)).rejects.toThrow(/aborted/);
    await a.flush();
    expect(wireA).toEqual([]);
  });

  it("入站：对端撤回 → ctx.signal abort，处理器抛错回 -32800；不转给 onNotification", async () => {
    const { a, wireB, seen, settle } = peers(true);
    const controller = new AbortController();
    const pending = a.request("slow", undefined, controller.signal).catch(() => undefined);
    await settle();
    controller.abort();
    await pending;
    await settle();
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.notes).toEqual([]);
    expect(wireB).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32800, message: "slow: request cancelled" } },
    ]);
  });

  it("入站：未知 requestId 忽略；处理完的请求不再可撤回", async () => {
    const { a, ab, wireB, seen, settle } = peers(true);
    await expect(a.request("quick")).resolves.toEqual({ ok: true });
    ab.write('{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":1}}\n');
    ab.write('{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":"x"}}\n');
    await settle();
    expect(seen.signal?.aborted).toBe(false);
    expect(wireB).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  it("缺省（Codex app-server 形状）：abort 不发线、入站 $/cancel_request 当普通通知、错误码不变", async () => {
    const { a, ab, wireA, wireB, seen, settle } = peers(undefined, false);
    const controller = new AbortController();
    const pending = a.request("slow", undefined, controller.signal);
    await settle();
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    ab.write('{"method":"$/cancel_request","params":{"requestId":1}}\n');
    await new Promise((r) => setTimeout(r, 350));
    expect(seen.notes).toEqual([["$/cancel_request", { requestId: 1 }]]);
    expect(seen.signal?.aborted).toBe(false);
    // a 只写了请求本身（第二行是测试手写进同一管道的入站通知）
    expect(wireA.map((l) => JSON.stringify(l))).toEqual([
      '{"id":1,"method":"slow"}',
      '{"method":"$/cancel_request","params":{"requestId":1}}',
    ]);
    expect(wireB.map((l) => JSON.stringify(l))).toEqual([
      '{"id":1,"error":{"code":-32603,"message":"handler gave up"}}',
    ]);
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
