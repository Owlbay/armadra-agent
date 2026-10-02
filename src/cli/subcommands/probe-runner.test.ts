import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultApiRegistry } from "../../ai/apis/api.js";
import type { Api, ProviderRegistryApi } from "../../ai/types.js";
import { ProbeScheduler, probeOnce } from "./probe-runner.js";
import { probeChannels } from "./providers-probe.js";

/**
 * fake 中转（本地 node:http）：按请求体里的模型 id 决定行为，记录同时在途数与连接关闭。
 * 用真实的 openai-completions 实现发请求，验证首事件判定、中止、并发上限、超时与 429。
 */
type Route = (res: ServerResponse, seen: number) => void;

let server: Server;
let baseUrl: string;
let inflight = 0;
let peak = 0;
let closed: string[] = [];
let hits: Record<string, number> = {};
const routes: Record<string, Route> = {};

const sse = (res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
};
const chunk = (res: ServerResponse, delta: Record<string, unknown>): void => {
  res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta }] })}\n\n`);
};
const finish = (res: ServerResponse, text: string): void => {
  sse(res);
  chunk(res, { role: "assistant", content: text });
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
};

routes["first-then-hang"] = (res) => {
  sse(res);
  chunk(res, { role: "assistant", content: "o" });
};
routes["role-only-then-hang"] = (res) => {
  sse(res);
  chunk(res, { role: "assistant" });
};
routes["role-then-error"] = (res) => {
  sse(res);
  chunk(res, { role: "assistant" });
  setTimeout(
    () => res.end(`data: ${JSON.stringify({ error: { message: "upstream down" } })}\n\n`),
    20,
  );
};
routes["silent"] = () => undefined;
routes["missing"] = (res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "model not found" } }));
};
const tooMany = (res: ServerResponse): void => {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "rate limited" } }));
};
routes["limited"] = tooMany;
routes["limited-once"] = (res, seen) => (seen === 1 ? tooMany(res) : finish(res, "ok"));
routes["hold"] = (res) => {
  setTimeout(() => finish(res, "ok"), 60);
};

beforeEach(async () => {
  inflight = 0;
  peak = 0;
  closed = [];
  hits = {};
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (part: Buffer) => (body += part.toString()));
    req.on("end", () => {
      const model = String((JSON.parse(body) as { model?: string }).model);
      const key = model.replace(/-\d+$/, "");
      hits[model] = (hits[model] ?? 0) + 1;
      inflight++;
      peak = Math.max(peak, inflight);
      res.on("close", () => {
        inflight--;
        closed.push(model);
      });
      (routes[key] ?? routes["missing"])!(res, hits[model]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const apis = createDefaultApiRegistry();
const registry = { getApi: (api: Api) => apis.get(api) } as unknown as ProviderRegistryApi;

function model(id: string) {
  return {
    id,
    name: id,
    api: "openai-completions" as const,
    provider: "relay",
    baseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 1000,
  };
}

const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("probeOnce", () => {
  it("首个内容事件即判可用，并中止请求、释放连接（服务端一直不结束也不等）", async () => {
    const started = Date.now();
    expect(
      await probeOnce(registry, model("first-then-hang"), "sk-test", { timeoutMs: 5000 }),
    ).toEqual({});
    expect(Date.now() - started).toBeLessThan(1000);
    await until(() => closed.includes("first-then-hang"));
    expect(inflight).toBe(0);
  });

  it("只有 start（没有内容）时等 settle 期：期间无 error 判可用；期间流里报错判不可用", async () => {
    const opts = { timeoutMs: 5000, settleMs: 100 };
    expect(await probeOnce(registry, model("role-only-then-hang"), "sk-test", opts)).toEqual({});
    await until(() => closed.includes("role-only-then-hang"));
    const failed = await probeOnce(registry, model("role-then-error"), "sk-test", opts);
    expect(failed.error).toContain("upstream down");
  });

  it("超时判不可用并断开；HTTP 错误判不可用并带状态码", async () => {
    const slow = await probeOnce(registry, model("silent"), "sk-test", { timeoutMs: 150 });
    expect(slow.error).toMatch(/^超时/);
    await until(() => closed.includes("silent"));
    const missing = await probeOnce(registry, model("missing"), "sk-test");
    expect(missing.error).toMatch(/^404 /);
  });
});

describe("ProbeScheduler", () => {
  it("同时在途 ≤ concurrency", async () => {
    const scheduler = new ProbeScheduler(registry, "sk-test", { concurrency: 3 });
    const results = await scheduler.run(10, (i) => scheduler.probe(model(`hold-${i}`)));
    expect(results.every((r) => r !== undefined && r.error === undefined)).toBe(true);
    expect(peak).toBe(3);
    expect(scheduler.peak).toBe(3);
  });

  it("429：并发减半、退避后重试一次；重试成功继续", async () => {
    const throttled: number[] = [];
    const scheduler = new ProbeScheduler(registry, "sk-test", {
      concurrency: 4,
      retryDelayMs: 50,
      recoverAfter: 100,
      onThrottle: (n) => throttled.push(n),
    });
    const results = await scheduler.run(4, (i) =>
      scheduler.probe(model(i === 0 ? "limited-once" : `hold-${i}`)),
    );
    expect(results.map((r) => r?.error)).toEqual([undefined, undefined, undefined, undefined]);
    expect(hits["limited-once"]).toBe(2);
    expect(throttled).toEqual([2]);
    expect(scheduler.concurrency).toBe(2);
    expect(scheduler.stopped).toBeUndefined();
  });

  it("429 后加法增：连续 recoverAfter 次没被限流就 +1，回到初始并发为止；再遇 429 重新减半", async () => {
    const changes: string[] = [];
    const scheduler = new ProbeScheduler(registry, "sk-test", {
      concurrency: 4,
      retryDelayMs: 10,
      recoverAfter: 2,
      onThrottle: (n) => changes.push(`-${n}`),
      onRecover: (n) => changes.push(`+${n}`),
    });
    const ids = (i: number): string => (i === 0 ? "limited-once" : `hold-${i}`);
    const results = await scheduler.run(16, (i) => scheduler.probe(model(ids(i))));
    expect(results.every((r) => r?.error === undefined)).toBe(true);
    expect(changes).toEqual(["-2", "+3", "+4"]);
    expect(scheduler.concurrency).toBe(4);
    expect(scheduler.peak).toBeLessThanOrEqual(4);
  });

  it("连续 429：停止，不再发新请求", async () => {
    const scheduler = new ProbeScheduler(registry, "sk-test", { concurrency: 1, retryDelayMs: 20 });
    const results = await scheduler.run(5, (i) =>
      scheduler.probe(model(i === 0 ? "limited" : `hold-${i}`)),
    );
    expect(scheduler.stopped).toMatch(/^连续 429 限流：429 /);
    expect(hits["limited"]).toBe(2);
    expect(results.slice(1)).toEqual([undefined, undefined, undefined, undefined]);
    expect(Object.keys(hits)).toEqual(["limited"]);
  });
});

describe("probeChannels", () => {
  it("结果按模型、渠道顺序输出（不按完成顺序）；非 TTY 只在结束打印汇总", async () => {
    routes["late"] = (res) => setTimeout(() => finish(res, "ok"), 150);
    const out: string[] = [];
    const channels = [
      { name: "chat", api: "openai-completions" as const, baseUrl },
      { name: "alt", api: "openai-completions" as const, baseUrl },
    ];
    const { results, stopped } = await probeChannels({
      io: { stdout: (t) => void out.push(t), stderr: () => undefined, stdoutIsTTY: false },
      providerId: "relay",
      ids: ["late", "first-then-hang", "missing"],
      channelsFor: (id) => (id === "missing" ? ["chat"] : ["chat", "alt"]),
      candidates: channels,
      registry,
      apiKey: "sk-test",
      concurrency: 5,
      timeoutMs: 5000,
    });
    expect(stopped).toBeUndefined();
    const text = out.join("");
    expect(text).not.toContain("\r");
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("  late  chat, alt");
    expect(lines[1]).toBe("  first-then-hang  chat, alt");
    expect(lines[2]).toMatch(/^ {2}missing {2}全部失败（失败 chat：404 /);
    expect(lines[3]).toMatch(/^探测完成 5\/5，用时 [\d.]+ s$/);
    expect(results.get("late")).toEqual({ ok: ["chat", "alt"] });
  });

  it("TTY：单行刷新进度", async () => {
    const out: string[] = [];
    await probeChannels({
      io: { stdout: (t) => void out.push(t), stderr: () => undefined, stdoutIsTTY: true },
      providerId: "relay",
      ids: ["hold"],
      channelsFor: () => ["chat"],
      candidates: [{ name: "chat", api: "openai-completions", baseUrl }],
      registry,
      apiKey: "sk-test",
      concurrency: 2,
      timeoutMs: 5000,
    });
    expect(out).toContain("\r\x1b[2K探测 1/1");
  });
});
