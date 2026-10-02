/**
 * 流空闲超时（W4-C）：用本地 node:http 模拟「发一块后停住」「迟迟不回响应头」「慢但不停」。
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFailure } from "../agent/retry.js";
import { openAICompletionsApi } from "./apis/openai-completions.js";
import { DEFAULT_IDLE_TIMEOUT_MS, idleTimeoutOf } from "./http.js";
import type { Model, StreamOptions } from "./types.js";

type Handler = (res: ServerResponse) => void;

let server: Server | undefined;
const pending: ServerResponse[] = [];

afterEach(async () => {
  for (const res of pending.splice(0)) res.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    pending.push(res);
    req.resume();
    req.on("end", () => handler(res));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

const chunk = (text: string): string =>
  `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: text } }] })}\n\n`;

const sseHead = (res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/event-stream" });
};

function model(baseUrl: string): Model {
  return {
    id: "m",
    name: "m",
    provider: "stall",
    api: "openai-completions",
    baseUrl,
    input: ["text"],
    reasoning: false,
    contextWindow: 8000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

async function run(baseUrl: string, extra: Partial<StreamOptions>) {
  const stream = openAICompletionsApi.stream(
    model(baseUrl),
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    { signal: new AbortController().signal, apiKey: "k", ...extra },
  );
  return stream.result();
}

describe("流空闲超时", () => {
  it("缺省 300 s；0 关闭", () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(300_000);
    expect(idleTimeoutOf({})).toBe(300_000);
    expect(idleTimeoutOf({ idleTimeoutMs: 0 })).toBeUndefined();
    expect(idleTimeoutOf({ idleTimeoutMs: 1234 })).toBe(1234);
  });

  it("发一块后停住：按空闲超时报错，文案明确且判为可重试", async () => {
    const url = await serve((res) => {
      sseHead(res);
      res.write(chunk("partial"));
    });
    const started = Date.now();
    const message = await run(url, { idleTimeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/Stream stalled: no data from the server for 200 ms/);
    expect(message.errorMessage).toContain("idle timeout");
    expect(classifyFailure(message)).toBe("retryable");
  });

  it("迟迟没有响应头：同一个空闲上限也管连接阶段", async () => {
    const url = await serve(() => undefined);
    const message = await run(url, { idleTimeoutMs: 200 });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/No response from the server within 200 ms/);
    expect(classifyFailure(message)).toBe("retryable");
  });

  it("慢但持续有数据：每收到一块重新计时，不误判", async () => {
    const url = await serve((res) => {
      sseHead(res);
      let sent = 0;
      const timer = setInterval(() => {
        if (sent < 5) {
          res.write(chunk(String(sent)));
          sent++;
          return;
        }
        clearInterval(timer);
        res.write(
          `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      }, 100);
    });
    const message = await run(url, { idleTimeoutMs: 300 });
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "01234" }]);
  });

  it("显式 timeoutMs 仍报原来的请求超时", async () => {
    const url = await serve(() => undefined);
    const message = await run(url, { timeoutMs: 150, idleTimeoutMs: 10_000 });
    expect(message.errorMessage).toMatch(/Request timed out after 150 ms/);
  });
});
