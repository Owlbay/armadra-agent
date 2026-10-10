/**
 * max_tokens 上限的跨进程缓存（#152）：写出、载回、30 天过期、坏文件忽略、按数据目录幂等。只用 fake fetch 与临时目录。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxTokensCaps, postWithMaxTokensFallback } from "../apis/max-tokens.js";
import {
  MAX_TOKENS_CACHE_TTL_MS,
  attachMaxTokensCache,
  loadMaxTokensCaps,
  maxTokensCachePath,
} from "./max-tokens-cache.js";

let dataDir: string;
const detachers: (() => void)[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ama-caps-"));
  maxTokensCaps.clear();
});

afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
  vi.unstubAllGlobals();
  maxTokensCaps.clear();
  rmSync(dataDir, { recursive: true, force: true });
});

const attach = (now?: () => number): void => {
  detachers.push(attachMaxTokensCache(dataDir, now));
};
const ok = () => new Response("data: {}\n\n", { status: 200 });
const reject = (text: string) =>
  new Response(JSON.stringify({ error: { type: "invalid_request_error", message: text } }), {
    status: 400,
  });
const post = (id = "kimi-k2.5") =>
  postWithMaxTokensFallback(
    { provider: "packy", id },
    "https://relay.test/v1/chat/completions",
    { headers: {}, body: { model: id, max_tokens: 262144 }, signal: new AbortController().signal },
    "max_tokens",
  );
const sentMax = (fetch: ReturnType<typeof vi.fn>): number[] =>
  fetch.mock.calls.map(
    ([, init]) =>
      (JSON.parse((init as RequestInit).body as string) as { max_tokens: number }).max_tokens,
  );
const readFile = (): {
  version: number;
  caps: Record<string, { cap: number; learnedAt: number }>;
} => JSON.parse(readFileSync(maxTokensCachePath(dataDir), "utf8"));
const writeFile = (content: string): void => {
  mkdirSync(join(dataDir, "models"), { recursive: true });
  writeFileSync(maxTokensCachePath(dataDir), content);
};

describe("max-tokens-cache", () => {
  it("400 学到上限 → 文件写出 cap 与 learnedAt；新进程载回后首个请求直接带上限、无 400", async () => {
    attach(() => 1_000_000);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reject("Range of max_tokens should be [1, 98304]"))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetch);
    await post();
    expect(readFile()).toEqual({
      version: 1,
      caps: { "packy/kimi-k2.5": { cap: 98304, learnedAt: 1_000_000 } },
    });

    // 模拟新进程：进程内的表清空，只靠文件
    maxTokensCaps.clear();
    expect(loadMaxTokensCaps(dataDir, () => 1_000_000 + 1000)).toBe(1);
    fetch.mockClear();
    await post();
    expect(sentMax(fetch)).toEqual([98304]);
  });

  it("超过 30 天的条目不载入，写回时被清掉；其它未过期条目保留", async () => {
    const now = 10 * MAX_TOKENS_CACHE_TTL_MS;
    writeFile(
      JSON.stringify({
        version: 1,
        caps: {
          "old/m": { cap: 1000, learnedAt: now - MAX_TOKENS_CACHE_TTL_MS - 24 * 3600 * 1000 },
          "fresh/m": { cap: 2000, learnedAt: now - 1000 },
        },
      }),
    );
    expect(loadMaxTokensCaps(dataDir, () => now)).toBe(1);
    expect(maxTokensCaps.has("old/m")).toBe(false);
    expect(maxTokensCaps.get("fresh/m")).toBe(2000);

    attach(() => now);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reject("Range of max_tokens should be [1, 8192]"))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetch);
    await post("other");
    expect(Object.keys(readFile().caps)).toEqual(["fresh/m", "packy/other"]);
  });

  it("进程内已学到的键优先，不被文件覆盖", () => {
    writeFile(JSON.stringify({ version: 1, caps: { "a/b": { cap: 100, learnedAt: Date.now() } } }));
    maxTokensCaps.set("a/b", 50);
    expect(loadMaxTokensCaps(dataDir)).toBe(0);
    expect(maxTokensCaps.get("a/b")).toBe(50);
  });

  it("坏 JSON、版本不符、形状不对的条目忽略不抛；缺文件也不抛", () => {
    expect(loadMaxTokensCaps(dataDir)).toBe(0);
    writeFile("{not json");
    expect(() => attach()).not.toThrow();
    expect(maxTokensCaps.size).toBe(0);
    writeFile(JSON.stringify({ version: 2, caps: { "a/b": { cap: 1, learnedAt: Date.now() } } }));
    expect(loadMaxTokensCaps(dataDir)).toBe(0);
    writeFile(
      JSON.stringify({
        version: 1,
        caps: { "a/b": { cap: "x", learnedAt: Date.now() }, "c/d": 5, "e/f": { cap: 7 } },
      }),
    );
    expect(loadMaxTokensCaps(dataDir)).toBe(0);
  });

  it("同一数据目录 attach 两次只订阅一次（只写一次文件）；取消后不再写", async () => {
    attach();
    attach();
    expect(detachers[0]).toBe(detachers[1]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reject("Range of max_tokens should be [1, 98304]"))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetch);
    const spy = vi.spyOn(JSON, "stringify");
    await post();
    const writes = spy.mock.calls.filter(
      ([value]) => typeof value === "object" && value !== null && "caps" in value,
    );
    spy.mockRestore();
    expect(writes).toHaveLength(1);

    detachers.splice(0).forEach((detach, i) => i === 0 && detach());
    rmSync(maxTokensCachePath(dataDir));
    maxTokensCaps.clear();
    fetch.mockResolvedValueOnce(reject("Range of max_tokens should be [1, 98304]"));
    await post();
    expect(() => readFileSync(maxTokensCachePath(dataDir))).toThrow();
  });
});
