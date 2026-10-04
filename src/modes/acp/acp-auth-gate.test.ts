import { afterEach, describe, expect, it } from "vitest";
import { assertAcpWire } from "../../../test/helpers/acp-schema.js";
import {
  composeHarness,
  recordingHost,
  type ComposeHarness,
} from "../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { parseArgs, type ParsedArgs } from "../../cli/args.js";
import { bootstrap } from "../../cli/bootstrap.js";
import { ExitCode } from "../../cli/exit-codes.js";
import { ACP_METHODS, RPC_ERRORS, type AcpInitializeResult } from "../../drivers/acp/types.js";
import { JsonRpcPeer, RpcError } from "../../drivers/jsonrpc.js";
import { memoryTransport } from "../../drivers/test-support.js";
import { msg } from "../../i18n/index.js";
import { runAcpAuthGate, terminalAuthMethods, type AcpAuthGateOptions } from "./acp-auth-gate.js";

let h: ComposeHarness = undefined!;
afterEach(() => {
  h?.cleanup();
  h = undefined!;
});

function argsOf(argv: string[]): ParsedArgs {
  const parsed = parseArgs(["--mode", "rpc", ...argv]);
  if (parsed.kind !== "run") throw new Error("subcommand");
  return parsed.args;
}

/** 无模型的第一次 bootstrap，再起认证门；客户端是裸 JSON-RPC 对等端（能控制 clientCapabilities）。 */
async function gate(
  argv: string[] = [],
  options: AcpAuthGateOptions = { retryIntervalMs: 0 },
  script?: FakeResponse[],
) {
  h ??= composeHarness(script);
  const args = argsOf(argv);
  const deps = h.deps();
  const cause = await bootstrap(args, deps, h.io).then(
    () => {
      throw new Error("bootstrap should fail without a model");
    },
    (error: unknown) => error,
  );
  let exit!: Promise<number>;
  const mem = memoryTransport((input, output) => {
    exit = runAcpAuthGate(args, deps, h.io, cause, { stdin: input, stdout: output, ...options });
    return exit;
  });
  const updates: unknown[] = [];
  const client = new JsonRpcPeer({
    input: mem.transport.stdout,
    output: mem.transport.stdin,
    onNotification: (_m, p) => updates.push(p),
  });
  return {
    client,
    updates,
    wire: mem.wire,
    /** 关客户端写端，等门控退出；线路逐条过 schema。 */
    async finish(): Promise<number> {
      mem.transport.stdin.end();
      const code = await exit;
      assertAcpWire(mem.wire);
      return code;
    },
  };
}

const init = (client: JsonRpcPeer, terminal: boolean) =>
  client.request<AcpInitializeResult>(ACP_METHODS.initialize, {
    protocolVersion: 1,
    clientCapabilities: terminal ? { auth: { terminal: true } } : {},
  });

async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}

const useFakeEcho = (): void =>
  void h.home.write("home/.config/ama/config.json", { version: 1, defaultModel: "fake/echo" });

describe("ama --mode acp 认证门（无模型）", () => {
  it("声明 auth.terminal：initialize 给两条 terminal 方法；session/new → -32000 带 data.authMethods", async () => {
    const t = await gate();
    const result = await init(t.client, true);
    expect(result.protocolVersion).toBe(1);
    expect(result.agentCapabilities).toMatchObject({ loadSession: true });
    expect(result.authMethods).toEqual([
      expect.objectContaining({
        type: "terminal",
        id: "chatgpt",
        args: ["auth", "login", "chatgpt"],
      }),
      expect.objectContaining({ type: "terminal", id: "api-key", args: ["auth", "set"] }),
    ]);
    const error = await rpcError(
      t.client.request(ACP_METHODS.sessionNew, { cwd: h.home.cwd, mcpServers: [] }),
    );
    expect(error.code).toBe(RPC_ERRORS.authRequired);
    expect(error.message).toContain("ama auth set");
    expect(error.data).toEqual({ authMethods: ["chatgpt", "api-key"] });
    expect(h.stderr()).toContain(`ama: ${msg().acp.auth.waiting(error.message)}`);
    expect(await t.finish()).toBe(ExitCode.Ok);
  });

  it("不声明 auth.terminal：authMethods 为空，-32000 的 data.authMethods 也为空", async () => {
    const t = await gate();
    expect((await init(t.client, false)).authMethods).toEqual([]);
    const error = await rpcError(t.client.request(ACP_METHODS.sessionList, {}));
    expect(error.code).toBe(RPC_ERRORS.authRequired);
    expect(error.data).toEqual({ authMethods: [] });
    expect(await t.finish()).toBe(0);
  });

  it("authenticate → -32602；未知方法 → -32601；交接前的通知忽略", async () => {
    const t = await gate();
    await init(t.client, true);
    const auth = await rpcError(
      t.client.request(ACP_METHODS.authenticate, { methodId: "chatgpt" }),
    );
    expect(auth.code).toBe(RPC_ERRORS.invalidParams);
    expect(auth.message).toBe(msg().acp.auth.notAgentMethod);
    expect((await rpcError(t.client.request("session/delete", { sessionId: "x" }))).code).toBe(
      RPC_ERRORS.methodNotFound,
    );
    await t.client.notify(ACP_METHODS.sessionCancel, { sessionId: "x" });
    expect(await t.finish()).toBe(0);
  });

  it("登录后（config.json 写 defaultModel）再 session/new：交接给服务端，同一连接 prompt 到 end_turn，关 stdin 退出 0", async () => {
    h = composeHarness([{ text: "hello after login" }]);
    const host = recordingHost(h.home, "__amaGateHost");
    const t = await gate(["--host", host.path]);
    await init(t.client, true);
    const failed = await rpcError(
      t.client.request(ACP_METHODS.sessionNew, { cwd: h.home.cwd, mcpServers: [] }),
    );
    expect(failed.code).toBe(RPC_ERRORS.authRequired);
    // R3：失败的重试停在模型解析，宿主没加载、没有 session_start
    expect(host.events()).toEqual([]);
    useFakeEcho();
    const created = await t.client.request<{ sessionId: string }>(ACP_METHODS.sessionNew, {
      cwd: h.home.cwd,
      mcpServers: [],
    });
    expect(created.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(host.events().filter((e) => e.name === "session_start")).toHaveLength(1);
    expect(h.stderr()).toContain(msg().acp.auth.ready("fake/echo"));
    const result = await t.client.request<{ stopReason: string }>(ACP_METHODS.sessionPrompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(result.stopReason).toBe("end_turn");
    const text = t.updates
      .map((n) => (n as { update: { sessionUpdate: string; content?: { text?: string } } }).update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "")
      .join("");
    expect(text).toBe("hello after login");
    // 交接后的 initialize 由服务端答；authenticate 仍是 -32602（与交接前一致）
    expect((await init(t.client, true)).protocolVersion).toBe(1);
    const auth = await rpcError(
      t.client.request(ACP_METHODS.authenticate, { methodId: "chatgpt" }),
    );
    expect(auth.code).toBe(RPC_ERRORS.invalidParams);
    expect(auth.message).toBe(msg().acp.auth.notAgentMethod);
    expect(await t.finish()).toBe(0);
  });

  it("重试 1 s 节流：间隔内不重跑 bootstrap（写了配置也仍回 -32000），过了间隔才重试", async () => {
    let clock = 10_000;
    const t = await gate([], { now: () => clock });
    await init(t.client, false);
    useFakeEcho();
    const throttled = await rpcError(
      t.client.request(ACP_METHODS.sessionNew, { cwd: h.home.cwd, mcpServers: [] }),
    );
    expect(throttled.code).toBe(RPC_ERRORS.authRequired);
    clock += 1000;
    const created = await t.client.request<{ sessionId: string }>(ACP_METHODS.sessionNew, {
      cwd: h.home.cwd,
      mcpServers: [],
    });
    expect(typeof created.sessionId).toBe("string");
    expect(await t.finish()).toBe(0);
  });

  it("并发的会话请求共用一次重试", async () => {
    const t = await gate();
    await init(t.client, false);
    useFakeEcho();
    const [a, b] = await Promise.all([
      t.client.request<{ sessionId: string }>(ACP_METHODS.sessionNew, {
        cwd: h.home.cwd,
        mcpServers: [],
      }),
      t.client.request<{ sessions: unknown[] }>(ACP_METHODS.sessionList, {}),
    ]);
    expect(typeof a.sessionId).toBe("string");
    expect(Array.isArray(b.sessions)).toBe(true);
    expect(await t.finish()).toBe(0);
  });

  it("R4：--auth-file 让两条 terminal 方法都带上绝对路径", async () => {
    const t = await gate(["--auth-file", "keys.json"]);
    const result = await init(t.client, true);
    const file = h.home.path("work", "keys.json");
    expect(result.authMethods?.map((m) => ("args" in m ? m.args : undefined))).toEqual([
      ["auth", "login", "chatgpt", "--auth-file", file],
      ["auth", "set", "--auth-file", file],
    ]);
    expect(await t.finish()).toBe(0);
  });

  it("R4：profile 的 authFile 同样带上", async () => {
    h = composeHarness();
    const authFile = h.home.path("home", "profile-auth.json");
    const profile = h.home.write("work/profile.json", { version: 1, authFile });
    const t = await gate(["--profile", profile]);
    const result = await init(t.client, true);
    expect(result.authMethods?.[1]).toMatchObject({
      args: ["auth", "set", "--auth-file", authFile],
    });
    expect(await t.finish()).toBe(0);
  });

  it("没有任何请求就关 stdin：退出 0", async () => {
    const t = await gate();
    expect(await t.finish()).toBe(0);
  });

  it("terminalAuthMethods 的 name / description 走 i18n", () => {
    const [chatgpt, apiKey] = terminalAuthMethods();
    expect(chatgpt).toMatchObject({ name: msg().acp.auth.chatgptName });
    expect(apiKey).toMatchObject({ description: msg().acp.auth.apiKeyDescription });
  });
});

describe("runCli --mode acp 无模型", () => {
  it("不再以退出码 4 结束：交给认证门（stdin 已关 → 退出 0）", async () => {
    h = composeHarness();
    const { PassThrough } = await import("node:stream");
    const stdin = new PassThrough();
    stdin.end();
    const saved = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    try {
      expect(await h.run(["--mode", "acp"])).toBe(0);
    } finally {
      Object.defineProperty(process, "stdin", saved);
    }
    expect(h.stderr()).toContain("ama auth set");
  });
});
