/**
 * 流契约（设计 §3.1）对两条协议与 fake 跑同一套断言：
 * 先 start；块事件配对；恰好一个终止事件；取消 → error{aborted}；toolcall_end 参数是对象；
 * 流函数不抛错（缺 key 例外：同步抛 no_api_key）；result() 在 error 时也 resolve。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { collectEvents } from "../event-stream.js";
import { FakeProvider, FAKE_MODELS } from "../fake/fake-provider.js";
import type { ApiImplementation, Model, StreamOptions } from "../types.js";
import { assertStreamContract } from "../../../test/ai/contract.js";
import { BASIC_CONTEXT } from "../../../test/ai/golden.js";
import {
  loadFixture,
  stubFetchHanging,
  stubFetchWithFixture,
} from "../../../test/ai/fixture-fetch.js";
import { anthropicMessagesApi } from "./anthropic-messages.js";
import { openAICompletionsApi } from "./openai-completions.js";
import { createDefaultApiRegistry } from "./api.js";

type Scenario = "text" | "tool" | "http-error" | "disconnect";

interface Subject {
  name: string;
  model: Model;
  /** 准备场景，返回要用的实现。 */
  setup(scenario: Scenario): ApiImplementation;
  /** 准备一个会挂起的流（abort 测试）。 */
  hang(): ApiImplementation;
}

const anthropicModel: Model = {
  id: "claude-sonnet-4-6",
  name: "s",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  input: ["text"],
  reasoning: true,
  maxTokens: 1000,
};
const openaiModel: Model = {
  ...anthropicModel,
  provider: "openai",
  api: "openai-completions",
  baseUrl: "https://api.openai.com/v1",
};
const fakeModel = FAKE_MODELS[0] as Model;

const FIXTURE_OF: Record<Scenario, string> = {
  text: "text",
  tool: "tool-multi",
  "http-error": "rate-limit-429",
  disconnect: "disconnect",
};

const subjects: Subject[] = [
  {
    name: "anthropic-messages",
    model: anthropicModel,
    setup: (scenario) => {
      stubFetchWithFixture(loadFixture("anthropic-messages", FIXTURE_OF[scenario]));
      return anthropicMessagesApi;
    },
    hang: () => {
      stubFetchHanging(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
      );
      return anthropicMessagesApi;
    },
  },
  {
    name: "openai-completions",
    model: openaiModel,
    setup: (scenario) => {
      stubFetchWithFixture(loadFixture("openai-completions", FIXTURE_OF[scenario]));
      return openAICompletionsApi;
    },
    hang: () => {
      stubFetchHanging(
        'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"hmm"}}]}\n\n',
      );
      return openAICompletionsApi;
    },
  },
  {
    name: "fake",
    model: fakeModel,
    setup: (scenario) => {
      const fake = new FakeProvider();
      if (scenario === "text") fake.setScript([{ text: "hello" }]);
      if (scenario === "tool") {
        fake.setScript([
          {
            steps: [
              { toolCall: { name: "grep", arguments: { pattern: "x" } }, chunkSize: 3 },
              { toolCall: { name: "ls" } },
            ],
          },
        ]);
      }
      if (scenario === "http-error") fake.setScript([{ error: { kind: "rate_limit" } }]);
      if (scenario === "disconnect") {
        fake.setScript([{ steps: [{ text: "partial" }], error: { kind: "disconnect" } }]);
      }
      return fake.api;
    },
    hang: () => {
      const fake = new FakeProvider([
        { steps: [{ thinking: "hmm" }, { delayMs: 60_000 }, { text: "never" }] },
      ]);
      return fake.api;
    },
  },
];

afterEach(() => vi.unstubAllGlobals());

const options = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "k",
  ...extra,
});

describe.each(subjects)("流契约：$name", (subject) => {
  it("纯文本：start → 块配对 → done(stop)", async () => {
    const stream = subject.setup("text").stream(subject.model, BASIC_CONTEXT, options());
    const events = await collectEvents(stream);
    const terminal = assertStreamContract(events, await stream.result());
    expect(terminal).toMatchObject({ type: "done", reason: "stop" });
  });

  it("工具调用：toolcall_end 时参数已是对象，done(toolUse)", async () => {
    const stream = subject.setup("tool").stream(subject.model, BASIC_CONTEXT, options());
    const events = await collectEvents(stream);
    const terminal = assertStreamContract(events, await stream.result());
    expect(terminal).toMatchObject({ type: "done", reason: "toolUse" });
    const ends = events.filter((e) => e.type === "toolcall_end");
    expect(ends.length).toBeGreaterThanOrEqual(2);
    expect(
      ends.every((e) => e.type === "toolcall_end" && typeof e.toolCall.arguments === "object"),
    ).toBe(true);
  });

  it("HTTP 错误：只有一个 error 事件，流函数不抛", async () => {
    const stream = subject.setup("http-error").stream(subject.model, BASIC_CONTEXT, options());
    const events = await collectEvents(stream);
    assertStreamContract(events, await stream.result());
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect((await stream.result()).errorMessage).toMatch(/^429 /);
  });

  it("断流：已有内容后 error，块已关闭", async () => {
    const stream = subject.setup("disconnect").stream(subject.model, BASIC_CONTEXT, options());
    const events = await collectEvents(stream);
    const final = await stream.result();
    expect(assertStreamContract(events, final)).toMatchObject({ type: "error", reason: "error" });
    expect(final.content.length).toBeGreaterThan(0);
    expect(final.errorMessage).toMatch(/Stream ended before completion/);
  });

  it("中止：error{reason:aborted}，result() resolve", async () => {
    const controller = new AbortController();
    const stream = subject
      .hang()
      .stream(subject.model, BASIC_CONTEXT, options({ signal: controller.signal }));
    const events = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "thinking_delta") controller.abort();
    }
    const final = await stream.result();
    expect(assertStreamContract(events, final)).toMatchObject({ type: "error", reason: "aborted" });
    expect(final.stopReason).toBe("aborted");
  });
});

describe("ApiRegistry 懒加载包装", () => {
  it("缺 key 同步抛；事件经包装原样转发；fake 无需 key", async () => {
    const registry = createDefaultApiRegistry();
    const anthropic = registry.get("anthropic-messages");
    expect(() =>
      anthropic?.stream(anthropicModel, BASIC_CONTEXT, { signal: new AbortController().signal }),
    ).toThrowError(expect.objectContaining({ code: "no_api_key" }));
    stubFetchWithFixture(loadFixture("anthropic-messages", "text"));
    const stream = anthropic?.stream(anthropicModel, BASIC_CONTEXT, options());
    if (!stream) throw new Error("missing");
    const events = await collectEvents(stream);
    assertStreamContract(events, await stream.result());
    const fake = registry.get("fake");
    const echo = fake?.stream(fakeModel, BASIC_CONTEXT, { signal: new AbortController().signal });
    expect((await echo?.result())?.content).toEqual([{ type: "text", text: "hi" }]);
    expect(registry.ids()).toEqual(["anthropic-messages", "openai-completions", "fake"]);
    expect(registry.get("google-generative-ai")).toBeUndefined();
  });

  it("detectCompat 不必加载实现模块", () => {
    const registry = createDefaultApiRegistry();
    const compat = registry.get("openai-completions")?.detectCompat?.(openaiModel, {
      id: "openai",
      name: "OpenAI",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      envKeys: [],
      models: [],
      requiresApiKey: true,
      builtin: true,
    });
    expect(compat).toMatchObject({ maxTokensField: "max_completion_tokens" });
  });
});
