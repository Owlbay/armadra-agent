import { describe, expect, it } from "vitest";
import { validateConfig } from "./schema.js";

function errors(providers: Record<string, unknown>): string[] {
  return validateConfig({ version: 1, providers })
    .filter((d) => d.severity === "error")
    .map((d) => `${d.path}: ${d.message}`);
}

const CHANNELS = {
  chat: { api: "openai-completions", baseUrl: "https://relay.example/v1" },
  messages: { api: "anthropic-messages", baseUrl: "https://relay.example", apiKey: "$OTHER" },
};

describe("config 校验：渠道", () => {
  it("合法的多渠道供应商没有错误", () => {
    expect(
      errors({
        relay: {
          apiKey: "$RELAY_KEY",
          channels: CHANNELS,
          defaultChannel: "chat",
          models: [
            { id: "kimi-k2.5", channels: ["chat", "messages"], modelsDev: "moonshotai/kimi-k2.5" },
            { id: "glm-5", modelsDev: false },
          ],
          modelOverrides: [{ id: "kimi-k2.5", channels: ["messages"] }],
        },
      }),
    ).toEqual([]);
  });

  it("旧写法（供应商级 api + baseUrl、模型级 api）照常合法", () => {
    expect(
      errors({
        packy: {
          baseUrl: "https://relay.example/v1",
          models: [{ id: "grok-4.7", api: "openai-responses" }],
        },
      }),
    ).toEqual([]);
  });

  it("渠道缺 api / baseUrl、名字非法、defaultChannel 与模型引用不存在的渠道：带路径报错", () => {
    expect(
      errors({
        relay: {
          channels: { chat: { api: "openai-completions" }, "bad@name": CHANNELS.chat },
          defaultChannel: "nope",
          models: [{ id: "m", channels: ["chat", "ghost"] }],
        },
      }),
    ).toEqual([
      "providers.relay.channels.chat.baseUrl: 缺少必填字符串",
      "providers.relay.channels.bad@name: 渠道名只能含字母、数字、_ 与 -（不含 / 与 @），最长 32",
      'providers.relay.defaultChannel: 渠道 "nope" 不存在',
      'providers.relay.models[0].channels[1]: 渠道 "ghost" 不存在（可用：chat）',
    ]);
  });

  it("没有 channels 时不能引用渠道；modelsDev 形状不对", () => {
    expect(
      errors({
        relay: {
          baseUrl: "https://relay.example/v1",
          defaultChannel: "chat",
          models: [{ id: "m", channels: ["chat"], modelsDev: "no-slash" }],
        },
      }),
    ).toEqual([
      "providers.relay.defaultChannel: 没有 channels 时不能设 defaultChannel",
      'providers.relay.models[0].modelsDev: 应为 "provider/model" 或 false',
      "providers.relay.models[0].channels[0]: 供应商没有 channels",
    ]);
    expect(errors({ relay: { channels: {} } })).toEqual([
      "providers.relay.channels: 至少要有一个渠道",
    ]);
  });

  it("内置供应商的内置渠道：defaultChannel / 模型 channels 可直接引用，同名渠道可只写部分字段", () => {
    expect(
      errors({
        deepseek: {
          defaultChannel: "messages",
          models: [{ id: "m", channels: ["messages"] }],
          modelOverrides: [{ id: "deepseek-flash", channels: ["chat"] }],
        },
        moonshot: {
          channels: { messages: { headers: { "x-a": "1" } }, relay: CHANNELS.chat },
          defaultChannel: "relay",
        },
      }),
    ).toEqual([]);
    expect(
      errors({
        deepseek: { defaultChannel: "responses", channels: { extra: { headers: {} } } },
        google: { defaultChannel: "gemini" },
      }),
    ).toEqual([
      "providers.deepseek.channels.extra.api: 缺少必填字符串",
      "providers.deepseek.channels.extra.baseUrl: 缺少必填字符串",
      'providers.deepseek.defaultChannel: 渠道 "responses" 不存在',
      "providers.google.defaultChannel: 没有 channels 时不能设 defaultChannel",
    ]);
  });
});
