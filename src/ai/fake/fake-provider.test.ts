import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome } from "../../../test/helpers/tmp-home.js";
import { assertStreamContract } from "../../../test/ai/contract.js";
import { collectEvents } from "../event-stream.js";
import { isContextOverflow } from "../overflow.js";
import type { Model, StreamOptions, TranscriptContext } from "../types.js";
import {
  FAKE_MODELS,
  FAKE_SCRIPT_ENV,
  FakeProvider,
  defaultFakeProvider,
} from "./fake-provider.js";
import { describeFakeError, loadFakeScript, parseFakeScript } from "./fake-script.js";
import { stopReasonOf } from "../apis/shared.js";

const echo = FAKE_MODELS[0] as Model;
const context: TranscriptContext = {
  messages: [
    { role: "system", sections: { preamble: "p" }, timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "ping" }], timestamp: 1 },
  ],
};
const opts = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  ...extra,
});

async function run(fake: FakeProvider, extra: Partial<StreamOptions> = {}) {
  const stream = fake.api.stream(echo, context, opts(extra));
  const events = await collectEvents(stream);
  const final = await stream.result();
  return { events, final, terminal: assertStreamContract(events, final) };
}

describe("FakeProvider", () => {
  it("stopReason refusal：与 Anthropic 拒答同形——error 收尾、rawStopReason refusal，stopReasonOf → refusal", async () => {
    const fake = new FakeProvider({
      version: 1,
      responses: [{ text: "partial", stopReason: "refusal" }, { text: "ok" }],
    });
    const refused = await run(fake);
    expect(refused.final).toMatchObject({ stopReason: "error", rawStopReason: "refusal" });
    expect(refused.final.errorMessage).toContain("refus");
    expect(stopReasonOf(refused.final)).toBe("refusal");
    const ok = await run(fake);
    expect(stopReasonOf(ok.final)).toBe("stop");
    expect(stopReasonOf({ stopReason: "error", rawStopReason: "content_filter" })).toBe("error");
  });

  it("无脚本：回显最后一条用户消息；记录调用", async () => {
    const fake = new FakeProvider();
    const { final } = await run(fake, { thinkingLevel: "low" });
    expect(final.content).toEqual([{ type: "text", text: "ping" }]);
    expect(final.provider).toBe("fake");
    expect(final.usage.output).toBe(1);
    expect(final.usage.cost?.total).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options.thinkingLevel).toBe("low");
  });

  it("按第 n 次调用产出：思考 + 工具调用 → 文本 → 429 → 溢出 → 断流 → length", async () => {
    const fake = new FakeProvider({
      version: 1,
      responses: [
        {
          steps: [
            { thinking: "plan", chunkSize: 2 },
            { toolCall: { name: "read", arguments: { path: "a.ts" }, id: "c1" }, chunkSize: 4 },
          ],
          usage: { input: 100, output: 7 },
        },
        { text: "done", usage: { input: 120, output: 1, cacheRead: 50 } },
        { error: { kind: "rate_limit" } },
        { error: { kind: "overflow" } },
        { steps: [{ text: "half" }], error: { kind: "disconnect" } },
        { text: "cut", stopReason: "length" },
      ],
      whenExhausted: "error",
    });
    const first = await run(fake);
    expect(first.terminal).toMatchObject({ type: "done", reason: "toolUse" });
    expect(first.final.content).toEqual([
      { type: "thinking", thinking: "plan", thinkingSignature: "fake-signature" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ]);
    expect(first.events.filter((e) => e.type === "toolcall_delta").length).toBe(4);
    expect(first.final.usage).toMatchObject({ input: 100, output: 7 });

    const second = await run(fake);
    expect(second.final.content).toEqual([{ type: "text", text: "done" }]);
    expect(second.final.usage.cacheRead).toBe(50);

    const third = await run(fake);
    expect(third.events.map((e) => e.type)).toEqual(["error"]);
    expect(third.final.errorMessage).toMatch(/^429 rate_limit_error/);

    const fourth = await run(fake);
    expect(isContextOverflow(fourth.final)).toBe(true);

    const fifth = await run(fake);
    expect(fifth.terminal).toMatchObject({ type: "error", reason: "error" });
    expect(fifth.final.content).toEqual([{ type: "text", text: "half" }]);
    expect(fifth.final.errorMessage).toBe("Stream ended before completion");

    const sixth = await run(fake);
    expect(sixth.terminal).toMatchObject({ type: "done", reason: "length" });

    const exhausted = await run(fake);
    expect(exhausted.final.errorMessage).toMatch(/exhausted at call 7/);
    expect(fake.callCount).toBe(7);
  });

  it("whenExhausted：缺省 echo；repeat-last 重复最后一条", async () => {
    const echoAfter = new FakeProvider([{ text: "one" }]);
    await run(echoAfter);
    expect((await run(echoAfter)).final.content).toEqual([{ type: "text", text: "ping" }]);
    const repeat = new FakeProvider({
      version: 1,
      responses: [{ text: "again" }],
      whenExhausted: "repeat-last",
    });
    await run(repeat);
    expect((await run(repeat)).final.content).toEqual([{ type: "text", text: "again" }]);
  });

  it("延迟可被 abort 打断；abort → error{aborted}", async () => {
    const fake = new FakeProvider([{ delayMs: 60_000, text: "late" }]);
    const controller = new AbortController();
    const stream = fake.api.stream(echo, context, opts({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    const events = await collectEvents(stream);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect((await stream.result()).stopReason).toBe("aborted");
  });

  it("onPayload / onResponse 被调用；append 追加响应", async () => {
    const fake = new FakeProvider();
    fake.append({ error: { kind: "auth" } });
    const statuses: number[] = [];
    const payloads: unknown[] = [];
    const { final } = await run(fake, {
      onResponse: (status) => statuses.push(status),
      onPayload: (p) => {
        payloads.push(p);
      },
    });
    expect(final.errorMessage).toMatch(/^401 /);
    expect(statuses).toEqual([401]);
    expect(payloads).toHaveLength(1);
  });

  it("录制开关：每次请求追加一行 { system, tools, messagesCount }（缺省实例读 AMA_FAKE_RECORD，由 bundle e2e 覆盖）", async () => {
    const home = createTmpHome("ama-fake-record-");
    try {
      const file = home.path("record.jsonl");
      const fake = new FakeProvider(undefined, { recordFile: file });
      const withTools: TranscriptContext = {
        messages: [
          {
            role: "system",
            sections: { preamble: "p" },
            toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }],
            timestamp: 0,
          },
          ...context.messages.slice(1),
        ],
      };
      await collectEvents(fake.api.stream(echo, withTools, opts()));
      await collectEvents(fake.api.stream(echo, context, opts({ purpose: "warm" })));
      const lines = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        index: 0,
        purpose: "turn",
        model: "fake/echo",
        system: "p",
        messagesCount: 1,
      });
      expect(lines[0]?.["tools"]).toEqual([
        { name: "read", description: "Read", parameters: { type: "object" } },
      ]);
      expect(lines[1]).toMatchObject({ index: 1, purpose: "warm", tools: [] });
    } finally {
      home.cleanup();
    }
  });
});

describe("fake 脚本", () => {
  it("校验报出路径；数组简写", () => {
    expect(parseFakeScript([{ text: "x" }])).toEqual({ version: 1, responses: [{ text: "x" }] });
    expect(() => parseFakeScript({ version: 2, responses: [] })).toThrowError(/\$\.version/);
    expect(() =>
      parseFakeScript({ version: 1, responses: [{ steps: [{ bogus: 1 }] }] }),
    ).toThrowError(/\$\.responses\[0\]\.steps\[0\]/);
    expect(() =>
      parseFakeScript({ version: 1, responses: [{ error: { kind: "nope" } }] }),
    ).toThrowError(/error\.kind/);
    expect(() => parseFakeScript({ version: 1, responses: [{ stopReason: "x" }] })).toThrowError(
      /stopReason/,
    );
  });

  it("test/fixtures/scripts 下的脚本都合法", () => {
    const dir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "test",
      "fixtures",
      "scripts",
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) expect(loadFakeScript(join(dir, file)).version).toBe(1);
  });

  it("错误文案与真实协议同形", () => {
    expect(describeFakeError({ kind: "overloaded" }).message).toBe(
      "529 overloaded_error: Overloaded",
    );
    expect(describeFakeError({ kind: "server" }).status).toBe(500);
    expect(describeFakeError({ kind: "network" }).message).toMatch(/^fetch failed/);
    expect(describeFakeError({ kind: "custom", message: "x", status: 418 })).toEqual({
      status: 418,
      message: "x",
    });
  });

  it("AMA_FAKE_SCRIPT：缺省实例首次调用时读取脚本文件", async () => {
    const tmp = createTmpHome();
    try {
      const path = join(tmp.root, "script.json");
      writeFileSync(path, JSON.stringify({ version: 1, responses: [{ text: "from file" }] }));
      expect(loadFakeScript(path).responses).toHaveLength(1);
      expect(() => loadFakeScript(join(tmp.root, "missing.json"))).toThrowError(/cannot read/);
      writeFileSync(join(tmp.root, "bad.json"), "{");
      expect(() => loadFakeScript(join(tmp.root, "bad.json"))).toThrowError(/not valid JSON/);
      process.env[FAKE_SCRIPT_ENV] = path;
      const { final } = await run(defaultFakeProvider);
      expect(final.content).toEqual([{ type: "text", text: "from file" }]);
    } finally {
      delete process.env[FAKE_SCRIPT_ENV];
      tmp.cleanup();
    }
  });
});

afterEach(() => {
  delete process.env[FAKE_SCRIPT_ENV];
});
