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
    expect(AcpClient.features.mcpServers).toBe(true);
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
