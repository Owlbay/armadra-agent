import { describe, expect, it } from "vitest";
import {
  capRequests,
  defaultChannels,
  hintedChannels,
  listingTarget,
  mergeProvider,
  orderChannels,
  parseChannelSpec,
  parseModelList,
  probeSelection,
  renderTable,
} from "./providers-plan.js";

const CANDIDATES = defaultChannels("https://relay.example/v1/");

describe("providers-plan", () => {
  it("defaultChannels：chat / responses 同 /v1，messages 取主机根；--api 只留一个", () => {
    expect(CANDIDATES).toEqual([
      { name: "chat", api: "openai-completions", baseUrl: "https://relay.example/v1" },
      { name: "responses", api: "openai-responses", baseUrl: "https://relay.example/v1" },
      { name: "messages", api: "anthropic-messages", baseUrl: "https://relay.example" },
    ]);
    expect(defaultChannels("https://r.example/v1", "anthropic-messages")).toEqual([
      { name: "messages", api: "anthropic-messages", baseUrl: "https://r.example" },
    ]);
    expect(() => defaultChannels("https://r", "bogus")).toThrow(/--api/);
  });

  it("parseChannelSpec", () => {
    expect(parseChannelSpec("msg=anthropic-messages@https://r.example/")).toEqual({
      name: "msg",
      api: "anthropic-messages",
      baseUrl: "https://r.example",
    });
    expect(() => parseChannelSpec("bad")).toThrow();
    expect(() => parseChannelSpec("a@b=openai-completions@https://x")).toThrow(/渠道名/);
    expect(() => parseChannelSpec("a=nope@https://x")).toThrow(/协议/);
  });

  it("parseModelList 与 supported_endpoint_types 提示", () => {
    const listed = parseModelList({
      data: [
        { id: "grok-4.7", supported_endpoint_types: ["openai-response"] },
        { id: "kimi-k2.5", supported_endpoint_types: ["openai", "anthropic"] },
        { id: "plain" },
        { id: "plain" },
        { nope: 1 },
      ],
    });
    expect(listed.map((m) => m.id)).toEqual(["grok-4.7", "kimi-k2.5", "plain"]);
    expect(hintedChannels(listed[0]!, CANDIDATES)).toEqual(["responses"]);
    expect(hintedChannels(listed[1]!, CANDIDATES)).toEqual(["chat", "messages"]);
    expect(hintedChannels(listed[2]!, CANDIDATES)).toBeUndefined();
    expect(parseModelList({})).toEqual([]);
  });

  it("listingTarget：OpenAI 系渠道优先；只有 Messages 时 /v1/models", () => {
    expect(listingTarget(CANDIDATES)?.url).toBe("https://relay.example/v1/models");
    expect(listingTarget([CANDIDATES[2]!])?.url).toBe("https://relay.example/v1/models");
    expect(listingTarget([])).toBeUndefined();
  });

  it("orderChannels / probeSelection / capRequests", () => {
    expect(orderChannels(["messages", "x", "chat"], ["chat", "responses", "messages"])).toEqual([
      "chat",
      "messages",
      "x",
    ]);
    expect(probeSelection(["b", "A", "c"], 2, undefined)).toEqual(["A", "b"]);
    expect(probeSelection(["b", "A", "c"], 2, ["c", "zz"])).toEqual(["c"]);
    const capped = capRequests(["a", "b", "c"], (id) => (id === "a" ? ["x"] : ["x", "y", "z"]), 5);
    expect(capped).toEqual({ ids: ["a", "b"], requests: 4, dropped: 1 });
  });

  it("mergeProvider：追加式，已有渠道与模型不改；没有模型挂载的渠道不写", () => {
    const first = mergeProvider(undefined, {
      apiKey: "$K",
      channels: CANDIDATES,
      models: [
        { id: "kimi-k2.5", channels: ["chat", "messages"] },
        { id: "nope", channels: [] },
      ],
      prefer: ["chat", "responses", "messages"],
    });
    expect(first.config).toEqual({
      apiKey: "$K",
      channels: {
        chat: { api: "openai-completions", baseUrl: "https://relay.example/v1" },
        messages: { api: "anthropic-messages", baseUrl: "https://relay.example" },
      },
      defaultChannel: "chat",
      models: [{ id: "kimi-k2.5", channels: ["chat", "messages"] }],
    });
    const edited = structuredClone(first.config);
    edited.models![0]!.contextWindow = 1234;
    edited.channels!.chat!.headers = { x: "1" };
    const second = mergeProvider(edited, {
      apiKey: "$OTHER",
      channels: CANDIDATES,
      models: [
        { id: "kimi-k2.5", channels: ["responses"] },
        { id: "grok-4.7", channels: ["responses"] },
      ],
      prefer: ["chat", "responses", "messages"],
    });
    expect(second.addedChannels).toEqual(["responses"]);
    expect(second.addedModels).toEqual(["grok-4.7"]);
    expect(second.config.apiKey).toBe("$K");
    expect(second.config.channels!.chat!.headers).toEqual({ x: "1" });
    expect(second.config.models![0]).toEqual({
      id: "kimi-k2.5",
      channels: ["chat", "messages"],
      contextWindow: 1234,
    });
  });

  it("renderTable 按显示宽度对齐", () => {
    const text = renderTable([
      {
        id: "kimi-k2.5",
        channels: ["chat", "messages"],
        status: "ok",
        fields: {
          contextWindow: 262144,
          maxTokens: 65536,
          input: ["text", "image"],
          reasoning: true,
          toolCall: true,
          cost: { input: 0.6, output: 2.5, cacheRead: 0.1, cacheWrite: 0.6 },
        },
        match: undefined,
      },
    ]);
    const [head, row] = text.split("\n");
    expect(head).toMatch(/^模型\s+渠道\s+上下文/);
    expect(row).toContain("kimi-k2.5");
    expect(row).toContain("262k");
    expect(row).toContain("$0.6/2.5");
    expect(row).toContain("探测通过");
    expect(row?.endsWith("未匹配")).toBe(true);
  });
});
