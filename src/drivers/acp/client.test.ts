import { describe, expect, it } from "vitest";
import { assertAcpWire } from "../../../test/helpers/acp-schema.js";
import { memoryTransport } from "../test-support.js";
import { runFakeAcpAgent } from "./testing/fake-agent.js";
import { AcpClient } from "./client.js";
import type { AcpStdioMcpServer } from "./types.js";

const SERVER: AcpStdioMcpServer = {
  name: "canvas",
  command: "/opt/host/bin/canvas-mcp",
  args: ["mcp"],
  env: [{ name: "HOST_NODE_ID", value: "n1" }],
};

/** 起一个假 Agent，返回客户端与线路记录。 */
async function connect() {
  const peer = memoryTransport((input, output) => runFakeAcpAgent(input, output));
  const client = new AcpClient({ input: peer.transport.stdout, output: peer.transport.stdin });
  await client.initialize();
  return { client, peer };
}

/** 线路上发给 Agent 的某个方法的 params。 */
function sent(peer: ReturnType<typeof memoryTransport>, method: string): unknown[] {
  return peer.wire
    .filter((line) => line.dir === "in" && line.msg["method"] === method)
    .map((line) => line.msg["params"]);
}

describe("AcpClient 开会话的 mcpServers", () => {
  it("声明特性，供宿主检测", () => {
    expect(AcpClient.features).toEqual({
      mcpServers: true,
      elicitation: true,
      configOptions: true,
    });
  });

  it("缺省发空数组（与旧版逐字节相同）", async () => {
    const { client, peer } = await connect();
    const { sessionId } = await client.newSession("/w");
    await client.resumeSession(sessionId, "/w");
    await client.loadSession(sessionId, "/w");
    expect(sent(peer, "session/new")).toEqual([{ cwd: "/w", mcpServers: [] }]);
    expect(sent(peer, "session/resume")).toEqual([{ sessionId, cwd: "/w", mcpServers: [] }]);
    expect(sent(peer, "session/load")).toEqual([{ sessionId, cwd: "/w", mcpServers: [] }]);
    await peer.transport.terminate();
  });

  it("new / resume / load 原样转发宿主给的服务器", async () => {
    const { client, peer } = await connect();
    const options = { mcpServers: [SERVER] };
    const { sessionId } = await client.newSession("/w", undefined, options);
    await client.resumeSession(sessionId, "/w", undefined, options);
    await client.loadSession(sessionId, "/w", undefined, options);
    for (const method of ["session/new", "session/resume", "session/load"]) {
      expect(sent(peer, method)).toEqual([expect.objectContaining({ mcpServers: [SERVER] })]);
    }
    await peer.transport.terminate();
  });

  it("不改调用方的数组，signal 照常生效", async () => {
    const { client, peer } = await connect();
    const servers = Object.freeze([SERVER]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.newSession("/w", controller.signal, { mcpServers: servers }),
    ).rejects.toThrow();
    expect(servers).toEqual([SERVER]);
    await peer.transport.terminate();
  });
});

/** 起假 Agent，带上 elicitation 处理器与假 Agent 选项；收集回复文本。 */
async function connectWith(
  options: {
    onElicitation?: ConstructorParameters<typeof AcpClient>[0]["onElicitation"];
    configOptions?: boolean;
  } = {},
) {
  const peer = memoryTransport((input, output) =>
    runFakeAcpAgent(input, output, { configOptions: options.configOptions === true }),
  );
  const replies: string[] = [];
  const client = new AcpClient({
    input: peer.transport.stdout,
    output: peer.transport.stdin,
    onUpdate: (n) => {
      if (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text")
        replies.push(n.update.content.text);
    },
    ...(options.onElicitation !== undefined ? { onElicitation: options.onElicitation } : {}),
  });
  await client.initialize();
  const { sessionId, configOptions } = await client.newSession("/w");
  return { client, peer, replies, sessionId, configOptions };
}

describe("AcpClient 的 elicitation", () => {
  it("没给处理器：不声明 elicitation，假 Agent 不发", async () => {
    const { client, peer, replies, sessionId } = await connectWith();
    const init = sent(peer, "initialize")[0] as { clientCapabilities: Record<string, unknown> };
    // [ACP-D] 多了 session.configOptions（只认 select）；elicitation 仍不声明
    expect(init.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      session: { configOptions: {} },
    });
    await client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    expect(replies).toEqual(["elicit: unsupported"]);
    await peer.transport.terminate();
  });

  it("给了处理器：声明能力，表单交给它，accept 的内容原样回 Agent", async () => {
    const seen: unknown[] = [];
    const { client, peer, replies, sessionId } = await connectWith({
      onElicitation: async (params) => {
        seen.push(params);
        return { action: "accept", content: { color: "blue", count: 2 } };
      },
    });
    const init = sent(peer, "initialize")[0] as { clientCapabilities: Record<string, unknown> };
    expect(init.clientCapabilities["elicitation"]).toEqual({});
    const result = await client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(seen).toEqual([
      expect.objectContaining({
        sessionId,
        message: "Pick a color",
        requestedSchema: expect.objectContaining({ required: ["color"] }),
      }),
    ]);
    expect(replies).toEqual(['elicit: accept {"color":"blue","count":2}']);
    await peer.transport.terminate();
  });

  it("答复收成规范形状：decline 不带内容，不认识的动作当 cancel", async () => {
    const answers = [
      { action: "decline", content: { color: "red" } },
      { action: "maybe" },
    ] as never[];
    const { client, peer, replies, sessionId } = await connectWith({
      onElicitation: async () => answers.shift()!,
    });
    await client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    const second = await client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    expect(replies).toEqual(["elicit: decline null", "elicit: cancel null"]);
    expect(second.stopReason).toBe("cancelled");
    await peer.transport.terminate();
  });

  it("cancel(sessionId)：挂起的 elicitation 回 cancel，处理器的 signal 被 abort", async () => {
    let aborted: AbortSignal | undefined;
    let asked!: () => void;
    const pending = new Promise<void>((resolve) => (asked = resolve));
    const { client, peer, replies, sessionId } = await connectWith({
      onElicitation: (_params, signal) => {
        aborted = signal;
        asked();
        return new Promise(() => undefined);
      },
    });
    const turn = client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    await pending;
    await client.cancel(sessionId);
    expect((await turn).stopReason).toBe("cancelled");
    expect(aborted?.aborted).toBe(true);
    expect(replies).toEqual(["elicit: cancel null"]);
    await peer.transport.terminate();
  });

  it("连接关闭：处理器的 signal 被 abort", async () => {
    let aborted: AbortSignal | undefined;
    let asked!: () => void;
    const pending = new Promise<void>((resolve) => (asked = resolve));
    const { client, peer, sessionId } = await connectWith({
      onElicitation: (_params, signal) => {
        aborted = signal;
        asked();
        return new Promise(() => undefined);
      },
    });
    void client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]).catch(() => undefined);
    await pending;
    await peer.transport.terminate();
    await client.closed;
    expect(aborted?.aborted).toBe(true);
  });
});

describe("AcpClient 的会话配置项", () => {
  it("假 Agent 缺省不答 configOptions（线路不变）", async () => {
    const { peer, configOptions } = await connectWith();
    expect(configOptions).toBeUndefined();
    await peer.transport.terminate();
  });

  it("开会话交回 configOptions，setConfigOption 改模型、答新状态", async () => {
    const { client, peer, replies, sessionId, configOptions } = await connectWith({
      configOptions: true,
    });
    expect(configOptions).toEqual([
      expect.objectContaining({ id: "model", category: "model", currentValue: "small" }),
    ]);
    const changed = await client.setConfigOption(sessionId, "model", "large");
    expect(changed.configOptions?.[0]?.currentValue).toBe("large");
    expect(sent(peer, "session/set_config_option")).toEqual([
      { sessionId, configId: "model", value: "large" },
    ]);
    await client.prompt(sessionId, [{ type: "text", text: "[model]" }]);
    expect(replies).toEqual(["model large"]);
    const loaded = await client.loadSession(sessionId, "/w");
    expect(loaded.configOptions?.[0]?.currentValue).toBe("large");
    await expect(client.setConfigOption(sessionId, "model", "huge")).rejects.toThrow(
      /unknown model/,
    );
    await peer.transport.terminate();
  });

  it("假 Agent 的 [env NAME] 只回值的摘要", async () => {
    const { client, peer, replies, sessionId } = await connectWith();
    process.env["AMA_FAKE_ENV_PROBE"] = "secret";
    try {
      await client.prompt(sessionId, [{ type: "text", text: "[env AMA_FAKE_ENV_PROBE]" }]);
      await client.prompt(sessionId, [{ type: "text", text: "[env AMA_FAKE_ENV_MISSING]" }]);
    } finally {
      delete process.env["AMA_FAKE_ENV_PROBE"];
    }
    expect(replies[0]).toMatch(/^env AMA_FAKE_ENV_PROBE [0-9a-f]{64}$/);
    expect(replies[0]).not.toContain("secret");
    expect(replies[1]).toBe("env AMA_FAKE_ENV_MISSING absent");
    await peer.transport.terminate();
  });
});

describe("[ACP-D] AcpClient 的 $/cancel_request", () => {
  it("本端请求的 signal 在发出后 abort → 通知 Agent 撤回；线路过 schema", async () => {
    const { client, peer, sessionId } = await connectWith();
    const controller = new AbortController();
    const pending = client.prompt(sessionId, [{ type: "text", text: "[slow]" }], controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    await client.cancel(sessionId);
    await new Promise((r) => setTimeout(r, 10));
    const prompt = peer.wire.find((w) => w.msg["method"] === "session/prompt")!;
    expect(sent(peer, "$/cancel_request")).toEqual([{ requestId: prompt.msg["id"] }]);
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("Agent 撤回挂起的权限请求 → 处理器的 signal abort，回 cancelled", async () => {
    const peer = memoryTransport((input, output) =>
      runFakeAcpAgent(input, output, { cancelRequestMs: 20 }),
    );
    let seen: AbortSignal | undefined;
    const client = new AcpClient({
      input: peer.transport.stdout,
      output: peer.transport.stdin,
      onPermission: (_params, signal) =>
        new Promise((resolve) => {
          seen = signal;
          signal.addEventListener("abort", () =>
            resolve({ outcome: { outcome: "selected", optionId: "allow" } }),
          );
        }),
    });
    await client.initialize();
    const { sessionId } = await client.newSession("/w");
    const result = await client.prompt(sessionId, [{ type: "text", text: "[cancel-request]" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(seen?.aborted).toBe(true);
    const ask = peer.wire.find((w) => w.msg["method"] === "session/request_permission")!;
    const answer = peer.wire.find(
      (w) => w.dir === "in" && w.msg["id"] === ask.msg["id"] && "result" in w.msg,
    );
    // 撤回后处理器给的选择不作数
    expect(answer?.msg["result"]).toEqual({ outcome: { outcome: "cancelled" } });
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });
});
