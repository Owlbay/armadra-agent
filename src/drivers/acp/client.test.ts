import { describe, expect, it } from "vitest";
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
  it("没给处理器：不声明能力，假 Agent 不发，线路与旧版相同", async () => {
    const { client, peer, replies, sessionId } = await connectWith();
    const init = sent(peer, "initialize")[0] as { clientCapabilities: Record<string, unknown> };
    expect(init.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
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
