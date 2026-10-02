import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as acp from "./acp.js";
import type { AgentDriver, DriverEvent } from "./acp.js";

describe("@armadra/agent/acp 子路径（W5-C0）", () => {
  it("package.json 导出 ./acp，指向 dist/acp", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports["./acp"]).toEqual({ types: "./dist/acp.d.ts", import: "./dist/acp.js" });
  });

  it("导出 NDJSON 分帧与驱动类型", async () => {
    expectTypeOf<DriverEvent["type"]>().toExtend<string>();
    expectTypeOf<AgentDriver["agentId"]>().toEqualTypeOf<string>();
    const stream = new PassThrough();
    const lines: string[] = [];
    const done = new Promise<void>((resolve) =>
      acp.createLineReader(stream, (l) => lines.push(l), resolve),
    );
    await acp.writeChunked(stream, '{"jsonrpc":"2.0","id":1}\n');
    stream.end('{"jsonrpc":"2.0","id":2}');
    await done;
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1}', '{"jsonrpc":"2.0","id":2}']);
  });

  it("[W5-E] 导出 AcpClient、AcpDriver、JSON-RPC 对等端与假 Agent", async () => {
    expect(typeof acp.AcpClient).toBe("function");
    expect(typeof acp.AcpDriver).toBe("function");
    expect(typeof acp.JsonRpcPeer).toBe("function");
    expect(typeof acp.runFakeAcpAgent).toBe("function");
    expect(acp.ACP_PROTOCOL_VERSION).toBe(1);
    expect(acp.fakeAcpAgentPath()).toMatch(/fake-agent-main\.js$/);
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const done = acp.runFakeAcpAgent(toAgent, fromAgent);
    const client = new acp.AcpClient({ input: fromAgent, output: toAgent });
    await client.initialize();
    const { sessionId } = await client.newSession("/w");
    expect(await client.prompt(sessionId, [{ type: "text", text: "x" }])).toMatchObject({
      stopReason: "end_turn",
    });
    toAgent.end();
    await done;
  });
});
