import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AmaConfig } from "../../config/types.js";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { formatModelRef, splitChannelRef } from "./channels.js";
import { ModelsDevIndex, trimModelsDev } from "./models-dev.js";
import { ProviderRegistry } from "./registry.js";

let tmp: TmpHome;
beforeEach(() => {
  tmp = createTmpHome();
});
afterEach(() => tmp.cleanup());

function registry(
  config: AmaConfig,
  env: Record<string, string> = {},
  modelsDev?: ModelsDevIndex,
): ProviderRegistry {
  return new ProviderRegistry({
    config,
    keys: { env, userAuthFile: join(tmp.configDir, "auth.json") },
    modelsDev,
    includeFake: false,
  });
}

const PACKY: AmaConfig = {
  version: 1,
  providers: {
    packy: {
      apiKey: "$PACKY_KEY",
      headers: { "x-from": "provider" },
      channels: {
        chat: { api: "openai-completions", baseUrl: "https://relay.example/v1" },
        responses: { api: "openai-responses", baseUrl: "https://relay.example/v1" },
        messages: {
          api: "anthropic-messages",
          baseUrl: "https://relay.example",
          apiKey: "$MSG_KEY",
          headers: { "x-from": "channel" },
          compat: { cacheReporting: "silent" },
        },
      },
      defaultChannel: "chat",
      models: [
        { id: "kimi-k2.5", channels: ["chat", "messages"], contextWindow: 262144 },
        { id: "grok-4.7", channels: ["responses"] },
        { id: "deepseek-v4-flash" },
        { id: "pinned", channels: ["messages"], api: "openai-completions" },
      ],
    },
  },
};

describe("渠道：解析与模型引用", () => {
  it("splitChannelRef / formatModelRef", () => {
    expect(splitChannelRef("packy/kimi-k2.5@messages")).toEqual({
      base: "packy/kimi-k2.5",
      channel: "messages",
    });
    expect(splitChannelRef("vertex/claude@2025/x")).toBeUndefined();
    expect(splitChannelRef("@x")).toBeUndefined();
    expect(formatModelRef({ provider: "p", id: "m" })).toBe("p/m");
    expect(formatModelRef({ provider: "p", id: "m", channel: "c" })).toBe("p/m@c");
  });

  it("provider/model 走首选渠道；未写 channels → defaultChannel", () => {
    const r = registry(PACKY);
    const provider = r.get("packy");
    expect(provider?.channels?.map((c) => c.name)).toEqual(["chat", "responses", "messages"]);
    expect(provider).toMatchObject({ api: "openai-completions", defaultChannel: "chat" });
    const kimi = r.findModel("packy/kimi-k2.5");
    expect(kimi.ok && kimi.model).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
      channel: "chat",
      channels: ["chat", "messages"],
      contextWindow: 262144,
    });
    const grok = r.findModel("packy/grok-4.7");
    expect(grok.ok && grok.model).toMatchObject({ api: "openai-responses", channel: "responses" });
    const ds = r.findModel("deepseek-v4-flash");
    expect(ds.ok && ds.model).toMatchObject({ channel: "chat", channels: ["chat"] });
  });

  it("provider/model@channel 显式指定：协议、地址、headers、compat 取渠道的", () => {
    const r = registry(PACKY);
    const found = r.findModel("packy/kimi-k2.5@messages");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.model).toMatchObject({
      id: "kimi-k2.5",
      api: "anthropic-messages",
      baseUrl: "https://relay.example",
      channel: "messages",
      headers: { "x-from": "channel" },
      compat: { cacheReporting: "silent" },
      contextWindow: 262144,
    });
    // 不带供应商前缀也可以
    const bare = r.findModel("kimi-k2.5@messages");
    expect(bare.ok && bare.model.channel).toBe("messages");
  });

  it("指定的渠道不在模型的 channels 里 → channel_not_found 并列出可用渠道", () => {
    const r = registry(PACKY);
    expect(r.findModel("packy/grok-4.7@chat")).toEqual({
      ok: false,
      reason: "channel_not_found",
      candidates: ["packy/grok-4.7@responses"],
    });
  });

  it("[W4-C] 渠道写错：中转供应商也不把 @后缀 合成进模型 id；供应商写错给最近的候选", () => {
    const r = registry(PACKY);
    const missing = r.findModel("packy/grok-4.7@nope");
    expect(missing).toMatchObject({ ok: false, reason: "channel_not_found" });
    expect(r.findModel("packy/brand-new@nope")).toMatchObject({ ok: false, reason: "not_found" });
    const open = registry({
      version: 1,
      providers: {
        relay: {
          apiKey: "k",
          channels: { chat: { api: "openai-completions", baseUrl: "https://relay.example/v1" } },
          defaultChannel: "chat",
        },
      },
    });
    expect(open.findModel("relay/any-model@nope")).toEqual({
      ok: false,
      reason: "channel_not_found",
      candidates: ["relay/any-model@chat"],
    });
    expect(open.findModel("relay/any-model@chat")).toMatchObject({ ok: true });
    expect(r.findModel("pakcy/grok-4.7")).toEqual({
      ok: false,
      reason: "provider_not_found",
      candidates: ["packy"],
    });
  });

  it("模型级 api 覆盖在渠道之上（匿名渠道）", () => {
    const r = registry(PACKY);
    const found = r.findModel("packy/pinned");
    expect(found.ok && found.model).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://relay.example",
      channel: "messages",
    });
  });

  it("@ 之后不是渠道名：整串仍按 model id（无渠道供应商）", () => {
    const r = registry({
      version: 1,
      providers: { vertex: { baseUrl: "https://v.example/v1", models: [{ id: "claude@2025" }] } },
    });
    const found = r.findModel("vertex/claude@2025");
    expect(found.ok && found.model.id).toBe("claude@2025");
    expect(found.ok && found.model.channel).toBeUndefined();
  });

  it("渠道 key：渠道自己的优先，否则供应商的；auth.json 的 provider@channel 条目也生效", async () => {
    const r = registry(PACKY, { PACKY_KEY: "pk", MSG_KEY: "mk" });
    expect((await r.resolveApiKey("packy", "messages")).apiKey).toBe("mk");
    expect((await r.resolveApiKey("packy", "chat")).apiKey).toBe("pk");
    expect((await r.resolveApiKey("packy")).apiKey).toBe("pk");
    writeFileSync(
      join(tmp.configDir, "auth.json"),
      JSON.stringify({ version: 1, providers: { "packy@responses": { apiKey: "rk" } } }),
    );
    const withAuth = registry(PACKY, { PACKY_KEY: "pk" });
    expect((await withAuth.resolveApiKey("packy", "responses")).apiKey).toBe("rk");
    expect((await withAuth.resolveApiKey("packy", "messages")).apiKey).toBe("pk");
  });

  it("向后兼容：没有 channels 的配置行为不变，模型上没有 channel 字段", () => {
    const r = registry({
      version: 1,
      providers: {
        old: {
          baseUrl: "https://relay.example/v1",
          models: [{ id: "a" }, { id: "b", api: "openai-responses" }],
          modelOverrides: [{ id: "a", api: "anthropic-messages" }],
        },
      },
    });
    const a = r.findModel("old/a");
    const b = r.findModel("old/b");
    expect(a.ok && a.model).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://relay.example/v1",
    });
    expect(b.ok && b.model.api).toBe("openai-responses");
    expect(a.ok && "channel" in a.model).toBe(false);
    expect(r.get("old")?.channels).toBeUndefined();
    const builtin = r.findModel("deepseek/deepseek-v4-pro");
    expect(builtin.ok && builtin.model.channel).toBeUndefined();
  });

  it("多供应商并存：同名模型互不冲突，带前缀各取各的渠道", () => {
    const r = registry({
      ...PACKY,
      providers: {
        ...PACKY.providers,
        other: {
          channels: { messages: { api: "anthropic-messages", baseUrl: "https://other.example" } },
          models: [{ id: "kimi-k2.5" }],
        },
      },
    });
    const a = r.findModel("packy/kimi-k2.5");
    const b = r.findModel("other/kimi-k2.5");
    expect(a.ok && a.model.channel).toBe("chat");
    expect(b.ok && b.model).toMatchObject({
      channel: "messages",
      baseUrl: "https://other.example",
    });
    expect(r.findModel("kimi-k2.5")).toMatchObject({ ok: false, reason: "ambiguous" });
  });
});

describe("models.dev 补全", () => {
  const index = new ModelsDevIndex(
    trimModelsDev({
      moonshotai: {
        id: "moonshotai",
        models: {
          "kimi-k2.5": {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: true,
            tool_call: true,
            modalities: { input: ["text", "image"] },
            limit: { context: 262144, output: 262144 },
            cost: { input: 0.6, output: 2.5, cache_read: 0.15 },
          },
        },
      },
    }),
  );

  it("配置写了的字段优先；缺的从 models.dev 补并记来源", () => {
    const r = registry(
      {
        version: 1,
        providers: {
          relay: {
            baseUrl: "https://relay.example/v1",
            models: [{ id: "kimi-k2.5", maxTokens: 4096 }, { id: "unknown-x" }],
          },
        },
      },
      {},
      index,
    );
    const kimi = r.findModel("relay/kimi-k2.5");
    expect(kimi.ok && kimi.model).toMatchObject({
      name: "Kimi K2.5",
      contextWindow: 262144,
      maxTokens: 4096,
      input: ["text", "image"],
      reasoning: true,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 },
    });
    expect(r.modelMetadata("relay", "kimi-k2.5")).toMatchObject({
      sources: {
        contextWindow: "models.dev",
        maxTokens: "config",
        input: "models.dev",
        reasoning: "models.dev",
        cost: "models.dev",
      },
      toolCall: true,
      match: { ref: "moonshotai/kimi-k2.5" },
    });
    const unknown = r.findModel("relay/unknown-x");
    expect(unknown.ok && unknown.model.contextWindow).toBeUndefined();
    expect(unknown.ok && unknown.model.maxTokens).toBe(8192);
    expect(r.modelMetadata("relay", "unknown-x")).toMatchObject({
      looked: true,
      match: undefined,
      sources: { contextWindow: "default" },
    });
  });

  it("modelsDev: false 关闭；modelOverrides 写的字段来源记为 config；内置目录从快照继承", () => {
    const r = registry(
      {
        version: 1,
        providers: {
          relay: {
            baseUrl: "https://relay.example/v1",
            models: [
              { id: "kimi-k2.5", modelsDev: false },
              { id: "k2", modelsDev: "moonshotai/kimi-k2.5" },
            ],
            modelOverrides: [{ id: "k2", contextWindow: 1000 }],
          },
        },
      },
      {},
      index,
    );
    const off = r.findModel("relay/kimi-k2.5");
    expect(off.ok && off.model.contextWindow).toBeUndefined();
    expect(off.ok && "modelsDev" in off.model).toBe(false);
    const k2 = r.findModel("relay/k2");
    expect(k2.ok && k2.model).toMatchObject({ contextWindow: 1000, input: ["text", "image"] });
    expect(r.modelMetadata("relay", "k2")?.sources.contextWindow).toBe("config");
    // [W5-M1] 内置目录的数值从入库快照继承（catalog.ts），不经过这里的 models.dev 补全
    expect(r.modelMetadata("moonshot", "kimi-k3")?.sources.contextWindow).toBe("models.dev");
    expect(r.modelMetadata("moonshot", "kimi-k3")?.looked).toBe(false);
  });

  it("没有缓存时不补，也不报错；惰性加载只在需要时调用", () => {
    let calls = 0;
    const r = new ProviderRegistry({
      config: { version: 1 },
      keys: { env: {} },
      modelsDev: () => {
        calls++;
        return undefined;
      },
    });
    expect(r.findModel("deepseek/deepseek-v4-pro").ok).toBe(true);
    expect(calls).toBe(0);
  });
});
