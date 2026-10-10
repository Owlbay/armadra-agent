/**
 * 请求体分块序列化（docs/memory-plan.md D3、§2.3、[M-B] 测试 1）：与
 * `Buffer.from(JSON.stringify(body), "utf8")` 逐字节相同——四个协议由黄金会话构造的请求体，
 * 以及 500 个随机 JSON（含 toJSON、undefined、NaN、-0、U+2028、孤立代理项、大字符串）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAnthropicRequest } from "./apis/anthropic-request.js";
import { buildGoogleRequest } from "./apis/google-request.js";
import { buildOpenAIRequest } from "./apis/openai-request.js";
import { buildResponsesRequest } from "./apis/openai-responses-request.js";
import {
  jsonFetchBody,
  LARGE_STRING_BYTES,
  serializeJsonBody,
  STREAM_CHUNK_CHARS,
} from "./json-body.js";
import type { Api, Message, Model, StreamOptions, TranscriptContext } from "./types.js";

const native = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");

/** `jsonFetchBody` 实际会发出的字节（流读完拼起来），以及声明的长度。 */
async function fetchBytes(
  value: unknown,
): Promise<{ bytes: Buffer; declared: number | undefined }> {
  const { body, contentLength } = jsonFetchBody(value);
  if (typeof body === "string")
    return { bytes: Buffer.from(body, "utf8"), declared: contentLength };
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return { bytes: Buffer.concat(chunks), declared: contentLength };
}

function expectSame(value: unknown): void {
  const got = serializeJsonBody(value);
  const want = native(value);
  if (!got.equals(want)) {
    // 只在失败时给出首个差异位置，避免把 MB 级字符串打进报告
    let i = 0;
    while (i < got.length && i < want.length && got[i] === want[i]) i++;
    const at = (b: Buffer) => b.subarray(Math.max(0, i - 40), i + 40).toString("utf8");
    expect({ length: got.length, at: at(got) }).toEqual({ length: want.length, at: at(want) });
  }
}

/** 确定性伪随机（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Like(length: number, seed: number): string {
  const next = rng(seed);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE64[Math.floor(next() * 64)];
  return out;
}

const LARGE = LARGE_STRING_BYTES;
const BIG = {
  base64: base64Like(LARGE + 17, 1),
  exact: base64Like(LARGE, 2),
  short: base64Like(LARGE - 1, 3),
  quote: `${base64Like(LARGE, 4)}"tail`,
  backslash: `${base64Like(LARGE, 5)}\\n`,
  control: `${base64Like(LARGE, 6)}\u0001\u001f`,
  newline: `${base64Like(LARGE, 7)}\n`,
  cjk: "中文字节".repeat(LARGE / 4 + 3),
  separators: `${"  ".repeat(LARGE / 2)}x`,
  emoji: `${base64Like(LARGE, 8)}😀`,
  lone: `${base64Like(LARGE, 9)}\ud800`,
  del: `${base64Like(LARGE, 10)}\u007f\u0080`,
};
const BIG_VALUES = Object.values(BIG);

class Point {
  constructor(
    readonly x: number,
    readonly y: string,
  ) {}
}

const SMALL_STRINGS = ["", "a", 'q"uote', "back\\slash", "tab\t", "  ", "\ud800", "😀", "中"];

function randomValue(next: () => number, depth: number): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const roll = next();
  if (depth > 5 || roll < 0.3) {
    return pick<unknown>([
      0,
      -0,
      1.5,
      -1e21,
      1e-7,
      Number.MAX_SAFE_INTEGER,
      NaN,
      Infinity,
      -Infinity,
      true,
      false,
      null,
      undefined,
      () => 1,
      Symbol("s"),
      ...SMALL_STRINGS,
    ]);
  }
  if (roll < 0.42) return pick(BIG_VALUES);
  if (roll < 0.5) {
    return pick<unknown>([
      new Date(0),
      { toJSON: (key: string) => `key:${key}` },
      { toJSON: () => undefined },
      { toJSON: () => ({ nested: BIG.base64 }) },
      Object.assign(() => 0, { toJSON: (key: string) => [key] }),
      new Point(1, BIG.base64),
      new Map([["a", 1]]),
      new String(BIG.base64),
      new Number(-0),
      new Boolean(false),
      new Uint8Array([1, 2]),
      Buffer.from("hi"),
      { [Symbol("k")]: 1, v: BIG.exact },
      {},
      [],
      [[]],
      { a: {} },
    ]);
  }
  if (roll < 0.75) {
    const length = Math.floor(next() * 6);
    const arr: unknown[] = [];
    for (let i = 0; i < length; i++) arr.push(randomValue(next, depth + 1));
    if (next() < 0.1) arr.length += 2; // 空洞 → null
    if (next() < 0.1) Object.assign(arr, { extra: BIG.base64 }); // 数组上的非索引属性不输出
    return arr;
  }
  const obj: Record<string, unknown> = next() < 0.1 ? Object.create(null) : {};
  const keys = ["a", "b", "2", "1", "data", "é ", '"k"', "\ud800", "toString"];
  const count = Math.floor(next() * 6);
  for (let i = 0; i < count; i++) obj[pick(keys)] = randomValue(next, depth + 1);
  return obj;
}

describe("jsonFetchBody", () => {
  it("不含大字符串：就是 JSON.stringify 的字符串，不声明长度", () => {
    const body = { a: [1, "x"], b: "中".repeat(100) };
    expect(jsonFetchBody(body)).toEqual({ body: JSON.stringify(body) });
  });

  it("含大字符串：流式发出，声明的长度等于 UTF-8 字节数；每块不超过最长的片段", async () => {
    const body = { a: BIG.base64, b: [BIG.cjk, BIG.quote, { c: BIG.exact }], d: "中文😀" };
    const { body: stream, contentLength } = jsonFetchBody(body);
    expect(stream).toBeInstanceOf(ReadableStream);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as ReadableStream<Uint8Array>) chunks.push(chunk);
    const want = native(body);
    expect(contentLength).toBe(want.length);
    expect(Buffer.concat(chunks).equals(want)).toBe(true);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(
      Math.max(
        ...[BIG.base64, BIG.cjk, BIG.quote].map((v) => Buffer.byteLength(JSON.stringify(v))),
      ) + 64,
    );
  });

  it("大片段分块发出：切点不拆开成对代理项，每块单独解码无替换字符，拼接逐字节相同", async () => {
    const emoji = "😀".repeat(STREAM_CHUNK_CHARS); // 两倍块长，切点落在每个码元位置都试一遍
    for (const head of ["", "x", "中", "xx"]) {
      for (const body of [
        { [`k${head}`]: `${head}${emoji}` },
        [head, emoji],
        [`${head}${emoji}`],
      ]) {
        const { body: stream } = jsonFetchBody(body);
        expect(stream).toBeInstanceOf(ReadableStream);
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream as ReadableStream<Uint8Array>) chunks.push(chunk);
        expect(chunks.length).toBeGreaterThan(2);
        for (const chunk of chunks) {
          expect(Buffer.from(chunk).toString("utf8")).not.toContain("\ufffd");
          expect(chunk.length).toBeLessThanOrEqual(STREAM_CHUNK_CHARS * 3);
        }
        expect(Buffer.concat(chunks).equals(native(body))).toBe(true);
      }
    }
  });

  it("顶层就是大字符串：需要转义时整体交给原生", async () => {
    for (const value of [BIG.base64, BIG.quote]) {
      expect((await fetchBytes(value)).bytes.equals(native(value))).toBe(true);
    }
  });
});

describe("serializeJsonBody 字节不变", () => {
  it("无大字符串：与原生相同（含顶层原始值）", () => {
    for (const value of [{ a: 1 }, [1, "x"], "s", 0, null, { a: undefined }, [undefined]]) {
      expectSame(value);
    }
  });

  it("边界与转义：恰好阈值、阈值减一、需转义的大字符串、代理项、非 ASCII", () => {
    for (const value of BIG_VALUES) {
      expectSame(value);
      expectSame({ data: value, after: 1 });
      expectSame([value, undefined, value]);
    }
  });

  it("对象里 undefined / 函数 / symbol 跳过，数组里写 null；toJSON 收到原生相同的键", () => {
    const seen: string[] = [];
    const probe = {
      toJSON(key: string) {
        seen.push(key);
        return key;
      },
    };
    const body = {
      skip: undefined,
      fn: () => 1,
      sym: Symbol("x"),
      first: BIG.base64,
      probe,
      list: [undefined, () => 1, Symbol("y"), probe, BIG.base64, { toJSON: () => undefined }],
      gone: { toJSON: () => undefined },
      bigTo: { toJSON: () => BIG.exact },
    };
    expectSame(body);
    seen.length = 0;
    serializeJsonBody(body);
    expect(seen).toEqual(["probe", "3"]);
  });

  it("原生会抛错的情形照样抛：bigint、环", () => {
    expect(() => serializeJsonBody({ a: BIG.base64, n: 1n })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = { data: BIG.base64 };
    cyclic["self"] = cyclic;
    expect(() => serializeJsonBody(cyclic)).toThrow(TypeError);
  });

  it("很深的嵌套：超过遍历上限的部分交给原生", () => {
    let deep: unknown = { data: BIG.base64 };
    for (let i = 0; i < 100; i++) deep = i % 2 ? { next: deep, i } : [deep, i];
    expectSame(deep);
  });

  it("500 个随机 JSON", async () => {
    const next = rng(20261010);
    let withLarge = 0;
    for (let i = 0; i < 500; i++) {
      const value = randomValue(next, 0);
      const text = JSON.stringify(value);
      if (text !== undefined && text.length >= LARGE) withLarge++;
      if (text === undefined) {
        expect(() => serializeJsonBody(value)).toThrow(TypeError);
        continue;
      }
      expectSame(value);
      const sent = await fetchBytes(value);
      expect(sent.bytes.equals(native(value))).toBe(true);
      if (sent.declared !== undefined) expect(sent.declared).toBe(sent.bytes.length);
    }
    // 随机样本里确实有相当一部分走了片段路径
    expect(withLarge).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// 四个协议：黄金会话（rpc prompt.out.jsonl 录到的 fake 转录）+ 图片、工具调用
// ---------------------------------------------------------------------------

function goldenMessages(): Message[] {
  const file = join(import.meta.dirname, "../../test/fixtures/rpc/prompt.out.jsonl");
  const messages: Message[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { type: string; entry?: { type: string; message?: Message } };
    if (event.type === "entry_appended" && event.entry?.type === "message" && event.entry.message) {
      messages.push(event.entry.message);
    }
  }
  return messages;
}

function goldenContext(): TranscriptContext {
  const golden = goldenMessages();
  expect(golden.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  const image = (seed: number) => ({
    type: "image" as const,
    data: base64Like(3 * LARGE, seed),
    mimeType: "image/png",
  });
  const extra: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "look   at 中文 😀" }, image(11)],
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.png" } },
      ],
      api: "fake",
      provider: "fake",
      model: "echo",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "toolUse",
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "Read image a.png" }, image(12)],
      isError: false,
      timestamp: 5,
    },
    { role: "user", content: `big text ${BIG.quote}`, timestamp: 6 },
  ];
  return { messages: [...golden, ...extra] };
}

function model(api: Api, id: string): Model {
  return {
    id,
    name: id,
    provider: "p",
    api,
    baseUrl: "https://example.test/v1",
    input: ["text", "image"],
    reasoning: true,
    maxTokens: 4096,
  };
}

const options = (cacheRetention: StreamOptions["cacheRetention"]): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "sk-test",
  sessionId: "sess-1",
  thinkingLevel: "medium",
  ...(cacheRetention ? { cacheRetention } : {}),
});

describe("serializeJsonBody 与四个协议的请求体", () => {
  const context = goldenContext();
  const builds = {
    anthropic: (o: StreamOptions) =>
      buildAnthropicRequest(model("anthropic-messages", "claude-sonnet-4-5"), context, o).body,
    openai: (o: StreamOptions) =>
      buildOpenAIRequest(model("openai-completions", "gpt-4o"), context, o).body,
    responses: (o: StreamOptions) =>
      buildResponsesRequest(model("openai-responses", "gpt-5"), context, o).body,
    google: (o: StreamOptions) =>
      buildGoogleRequest(model("google-generative-ai", "gemini-2.5-pro"), context, o).body,
  };

  for (const [name, build] of Object.entries(builds)) {
    it(`${name}：缓存 short / long / none 三档逐字节相同（Buffer 与流），且确实含图片`, async () => {
      for (const retention of ["short", "long", "none"] as const) {
        const body = build(options(retention));
        const want = native(body);
        const bytes = serializeJsonBody(body);
        expect(bytes.equals(want)).toBe(true);
        expect(bytes.length).toBeGreaterThan(6 * LARGE);
        const sent = await fetchBytes(body);
        expect(sent.declared).toBe(want.length);
        expect(sent.bytes.equals(want)).toBe(true);
      }
    });
  }

  it("anthropic 请求体带 cache_control（断点在片段路径上照样输出）", () => {
    const body = builds.anthropic(options("long"));
    expect(serializeJsonBody(body).toString("utf8")).toContain('"cache_control"');
  });
});
