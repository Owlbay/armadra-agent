import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { joinPrompt } from "./print-mode.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

function lines(): Record<string, unknown>[] {
  return h
    .stdout()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("print 模式", () => {
  it("text：只输出最后的助手文本，退出 0", async () => {
    h = composeHarness([{ text: "hello there" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("hello there\n");
  });

  it("text：去掉前导空行、保留首行缩进；json 的 text 原样", async () => {
    h = composeHarness([{ text: "\n\n  indented\nnext" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("  indented\nnext\n");
    h.cleanup();
    h = composeHarness([{ text: "\n \n" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("");
    h.cleanup();
    h = composeHarness([{ text: "\n\nraw" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "json"])).toBe(0);
    expect(lines()[0]).toMatchObject({ text: "\n\nraw" });
  });

  it("stdin 管道与参数拼接；两者都没有 → 2", async () => {
    h = composeHarness(undefined, { readStdin: async () => "piped text\n" });
    expect(await h.run(["-p", "question", "--model", "fake/echo"])).toBe(0);
    expect(h.fake.calls[0]?.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: "question\n\npiped text",
    });
    expect(joinPrompt(undefined, "")).toBe("");
    h.cleanup();
    h = composeHarness(undefined, { readStdin: async () => "" });
    expect(await h.run(["-p", "--model", "fake/echo"])).toBe(2);
    expect(h.stderr()).toContain("需要提示");
  });

  it("json：一个结果对象，含停止原因、用量与条目", async () => {
    h = composeHarness([{ text: "done", usage: { input: 10, output: 2, cacheRead: 30 } }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "json"])).toBe(0);
    const [result] = lines();
    expect(result).toMatchObject({ type: "result", stopReason: "stop", text: "done" });
    expect(result?.["cacheHitRate"]).toBe(0.75);
    expect((result?.["entries"] as unknown[]).length).toBeGreaterThan(2);
  });

  it("stream-json：逐事件一行，重试事件可见，message_update 无 partial", async () => {
    h = composeHarness([
      { error: { kind: "rate_limit" } },
      { error: { kind: "overloaded" } },
      { text: "Recovered after retries." },
    ]);
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    expect(
      await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "stream-json"]),
    ).toBe(0);
    const types = lines().map((e) => e["type"]);
    expect(types).toContain("auto_retry_start");
    expect(types).toContain("auto_retry_end");
    expect(types.at(-1)).toBe("agent_settled");
    expect(h.stdout()).not.toContain('"partial"');
  });

  it("最终错误 → 退出 1，stderr 给原因；工具 ask 在 print 下被拒", async () => {
    h = composeHarness([{ error: { kind: "auth" } }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(1);
    expect(h.stderr()).toMatch(/ama: .+/);
    h.cleanup();
    h = composeHarness([
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo x" } } }] },
      { text: "after" },
    ]);
    expect(await h.run(["-p", "run", "--model", "fake/echo"])).toBe(0);
    const result = h.fake.calls[1]?.context.messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({ isError: true });
  });

  it("[W3-C2] json 结果带 cache 统计；stream-json 含 cache_miss / cache_warm / context_pressure", async () => {
    sharedCacheReporting.clear();
    const config = {
      version: 1,
      // fake 供应商不读 modelOverrides（它在配置之后才补进注册表）：整条声明一个带缓存 TTL 的 echo
      providers: {
        fake: {
          api: "fake",
          baseUrl: "fake://local",
          requiresApiKey: false,
          models: [
            {
              id: "echo",
              contextWindow: 200_000,
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
              promptCache: { short: 300 },
            },
          ],
        },
      },
    };
    h = composeHarness(CACHE_RUN);
    h.home.write("home/.config/ama/config.json", config);
    h.home.write("work/notes.txt", "x\n");
    expect(await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "json"])).toBe(0);
    const cache = lines()[0]?.["cache"] as Record<string, unknown>;
    expect(cache).toMatchObject({
      reporting: "reported",
      lastHitRate: 0,
      reBilledTokens: 142_000,
      misses: { count: 1, byReason: { evicted: 1 } },
      warming: { mode: "streaming", state: "inactive" },
    });
    expect(cache["reBilledUsd"]).toBeCloseTo(0.1278, 4);
    h.cleanup();

    sharedCacheReporting.clear();
    h = composeHarness(CACHE_RUN);
    h.home.write("home/.config/ama/config.json", config);
    h.home.write("work/notes.txt", "x\n");
    expect(
      await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "stream-json"]),
    ).toBe(0);
    const events = lines();
    expect(events.find((e) => e["type"] === "context_pressure")).toMatchObject({
      percent: 71,
      threshold: 70,
      remainingTokens: 57_990,
    });
    expect(events.find((e) => e["type"] === "cache_warm")).toMatchObject({ phase: "scheduled" });
    expect(events.find((e) => e["type"] === "cache_miss")).toMatchObject({
      reason: "evicted",
      missedTokens: 142_000,
    });
  });
});

const CACHE_RUN: FakeResponse[] = [
  {
    steps: [{ toolCall: { name: "read", arguments: { path: "notes.txt" } } }],
    usage: { input: 2_000, output: 10, cacheRead: 140_000 },
  },
  { text: "done", usage: { input: 150_000, output: 10 } },
];
