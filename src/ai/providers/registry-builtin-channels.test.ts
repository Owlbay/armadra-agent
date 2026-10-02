import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AmaConfig } from "../../config/types.js";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { BUILTIN_PROVIDERS, isRelayedBaseUrl } from "./builtin.js";
import { catalogChannels, mergeChannels, parseChannels } from "./channels.js";
import { ModelsDevIndex } from "./models-dev.js";
import { builtinSnapshot } from "./models-dev-snapshot.js";
import { ProviderRegistry } from "./registry.js";

let tmp: TmpHome;
beforeEach(() => {
  tmp = createTmpHome();
});
afterEach(() => tmp.cleanup());

function registry(
  config: AmaConfig = { version: 1 },
  options: { env?: Record<string, string>; modelsDev?: ModelsDevIndex } = {},
): ProviderRegistry {
  return new ProviderRegistry({
    config,
    keys: { env: options.env ?? {}, userAuthFile: join(tmp.configDir, "auth.json") },
    modelsDev: options.modelsDev,
    includeFake: false,
  });
}

function model(r: ProviderRegistry, ref: string) {
  const found = r.findModel(ref);
  if (!found.ok) throw new Error(`${ref}: ${found.reason} ${found.candidates.join(",")}`);
  return found.model;
}

describe("内置渠道：数据", () => {
  it("每家内置渠道名合法、不重名，defaultChannel 在表里；单渠道回落的主机是某个渠道的主机", () => {
    for (const p of BUILTIN_PROVIDERS) {
      if (p.channels === undefined) {
        expect(p.defaultChannel, p.id).toBeUndefined();
        continue;
      }
      const names = p.channels.map((c) => c.name);
      expect(new Set(names).size, p.id).toBe(names.length);
      expect(names, p.id).toContain(p.defaultChannel);
      expect(isRelayedBaseUrl(p.id, p.baseUrl), p.id).toBe(false);
      for (const c of p.channels) expect(isRelayedBaseUrl(p.id, c.baseUrl), c.name).toBe(false);
    }
  });

  it("isRelayedBaseUrl 按渠道比较主机：国际站不算中转，别的主机算", () => {
    expect(isRelayedBaseUrl("zhipu", "https://api.z.ai/api/anthropic")).toBe(false);
    expect(isRelayedBaseUrl("dashscope", "https://dashscope-intl.aliyuncs.com/x")).toBe(false);
    expect(isRelayedBaseUrl("deepseek", "https://relay.example/v1")).toBe(true);
    expect(isRelayedBaseUrl("deepseek", "not a url")).toBe(true);
    expect(isRelayedBaseUrl("ollama", "https://relay.example/v1")).toBe(false);
    expect(isRelayedBaseUrl("custom", "https://relay.example/v1")).toBe(false);
  });
});

describe("内置渠道：物化真值表", () => {
  it.each([
    ["deepseek/deepseek-v4-pro", "chat", "openai-completions", "https://api.deepseek.com"],
    [
      "deepseek/deepseek-v4-pro@messages",
      "messages",
      "anthropic-messages",
      "https://api.deepseek.com/anthropic",
    ],
    [
      "dashscope/qwen3.8-max",
      "messages",
      "anthropic-messages",
      "https://dashscope.aliyuncs.com/apps/anthropic",
    ],
    [
      "dashscope/qwen3.8-max@chat-intl",
      "chat-intl",
      "openai-completions",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    ],
    ["zhipu/glm-5.3", "chat", "openai-completions", "https://open.bigmodel.cn/api/paas/v4"],
    ["moonshot/kimi-k3@responses", "responses", "openai-responses", "https://api.moonshot.cn/v1"],
  ])("%s → %s", (ref, channel, api, baseUrl) => {
    expect(model(registry(), ref)).toMatchObject({ channel, api, baseUrl });
  });

  it("目录模型挂全部渠道、缺省在前；供应商级 api / baseUrl 取缺省渠道的", () => {
    const r = registry();
    const kimi = model(r, "moonshot/kimi-k3");
    expect(kimi.channels).toEqual(["chat", "messages", "responses", "chat-intl", "messages-intl"]);
    const qwen = r.get("dashscope");
    expect(qwen).toMatchObject({
      defaultChannel: "messages",
      api: "anthropic-messages",
      baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    });
    expect(r.isRelayed("dashscope")).toBe(false);
  });

  it("渠道的 authHeader 进模型：Kimi 的 Messages 用 Bearer，DeepSeek 按协议缺省", () => {
    const r = registry();
    expect(model(r, "moonshot/kimi-k3@messages").authHeader).toBe("authorization-bearer");
    expect(model(r, "moonshot/kimi-k3").authHeader).toBeUndefined();
    expect(model(r, "deepseek/deepseek-flash@messages").authHeader).toBeUndefined();
  });

  it("不存在的渠道 → channel_not_found 并列出可用渠道", () => {
    const found = registry().findModel("deepseek/deepseek-flash@responses");
    expect(found).toMatchObject({ ok: false, reason: "channel_not_found" });
    expect(!found.ok && found.candidates).toContain("deepseek/deepseek-flash@messages");
  });
});

describe("内置渠道 ← 用户配置", () => {
  it("只写 defaultChannel：切到该内置渠道；不存在的渠道警告并保持缺省", () => {
    const r = registry({
      version: 1,
      providers: { deepseek: { defaultChannel: "messages" }, zhipu: { defaultChannel: "nope" } },
    });
    expect(model(r, "deepseek/deepseek-v4-pro")).toMatchObject({
      channel: "messages",
      api: "anthropic-messages",
    });
    expect(r.get("deepseek")?.api).toBe("anthropic-messages");
    expect(model(r, "deepseek/deepseek-v4-pro").channels?.[0]).toBe("messages");
    expect(model(r, "zhipu/glm-5.3").channel).toBe("chat");
    expect(r.warnings.join("\n")).toContain('defaultChannel "nope" not found');
  });

  it("只写 api：选同协议的内置渠道；没有同协议的渠道 → 内置渠道作废、按单渠道", () => {
    const r = registry({
      version: 1,
      providers: {
        deepseek: { api: "anthropic-messages" },
        zhipu: { api: "openai-responses" },
      },
    });
    expect(model(r, "deepseek/deepseek-flash").channel).toBe("messages");
    const glm = model(r, "zhipu/glm-5.3");
    expect(glm.channel).toBeUndefined();
    expect(glm.channels).toBeUndefined();
    expect(glm).toMatchObject({ api: "openai-responses" });
  });

  it("改 baseUrl（config）：内置渠道作废，回落到单渠道、按中转处理", () => {
    const r = registry({
      version: 1,
      providers: { dashscope: { baseUrl: "https://relay.example/v1" } },
    });
    const qwen = model(r, "dashscope/qwen3.8-max");
    expect(qwen).toMatchObject({ api: "openai-completions", baseUrl: "https://relay.example/v1" });
    expect(qwen.channel).toBeUndefined();
    expect(r.get("dashscope")?.channels).toBeUndefined();
    expect(r.isRelayed("dashscope")).toBe(true);
    expect(r.findModel("dashscope/qwen3.8-max@messages")).toMatchObject({
      ok: false,
      reason: "channel_not_found",
    });
  });

  it("改 baseUrl（auth.json）：同样作废", () => {
    const authFile = join(tmp.configDir, "auth.json");
    writeFileSync(
      authFile,
      JSON.stringify({
        version: 1,
        providers: { deepseek: { apiKey: "sk-x", baseUrl: "https://relay.example" } },
      }),
    );
    const r = registry();
    expect(model(r, "deepseek/deepseek-flash")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://relay.example",
    });
    expect(r.get("deepseek")?.channels).toBeUndefined();
  });

  it("用户 channels：同名字段级覆盖（保留内置 authHeader / compat）、新名追加，目录模型可用新渠道", () => {
    const r = registry({
      version: 1,
      providers: {
        moonshot: {
          channels: {
            messages: {
              api: "anthropic-messages",
              baseUrl: "https://relay.example",
              headers: { "x-a": "1" },
            },
            relay: { api: "openai-completions", baseUrl: "https://relay.example/v1" },
          },
        },
      },
    });
    const viaMessages = model(r, "moonshot/kimi-k3@messages");
    expect(viaMessages).toMatchObject({
      baseUrl: "https://relay.example",
      authHeader: "authorization-bearer",
      headers: { "x-a": "1" },
    });
    expect(model(r, "moonshot/kimi-k3").channel).toBe("chat");
    expect(model(r, "moonshot/kimi-k3@relay").baseUrl).toBe("https://relay.example/v1");
    expect(r.get("moonshot")?.channels?.map((c) => c.name)).toEqual([
      "chat",
      "messages",
      "responses",
      "chat-intl",
      "messages-intl",
      "relay",
    ]);
  });

  it("用户写了 channels 时 auth.json 的 baseUrl 不作废渠道", () => {
    writeFileSync(
      join(tmp.configDir, "auth.json"),
      JSON.stringify({
        version: 1,
        providers: { zhipu: { apiKey: "k", baseUrl: "https://other.example" } },
      }),
    );
    const r = registry({
      version: 1,
      providers: {
        zhipu: {
          channels: { relay: { api: "openai-completions", baseUrl: "https://relay.example/v1" } },
          defaultChannel: "relay",
        },
      },
    });
    expect(model(r, "zhipu/glm-5.3")).toMatchObject({
      channel: "relay",
      baseUrl: "https://relay.example/v1",
    });
    expect(model(r, "zhipu/glm-5.3@messages").api).toBe("anthropic-messages");
  });

  it("用户给内置供应商加模型：没写 channels 挂全部渠道，写了的按写的", () => {
    const r = registry({
      version: 1,
      providers: {
        deepseek: {
          models: [{ id: "deepseek-new" }, { id: "deepseek-msg", channels: ["messages"] }],
        },
      },
    });
    expect(model(r, "deepseek/deepseek-new").channels).toEqual(["chat", "messages"]);
    expect(model(r, "deepseek/deepseek-msg")).toMatchObject({
      channel: "messages",
      channels: ["messages"],
    });
  });
});

describe("渠道合并的纯函数", () => {
  it("mergeChannels / parseChannels：同名只写部分字段也行，defaultChannel 用户 > 内置 > 首个", () => {
    const base = [
      { name: "a", api: "openai-completions" as const, baseUrl: "https://a", compat: { x: 1 } },
      { name: "b", api: "anthropic-messages" as const, baseUrl: "https://b" },
    ];
    const merged = mergeChannels(base as never, [
      { name: "a", headers: { h: "1" }, compat: { y: 2 } } as never,
    ]);
    expect(merged[0]).toMatchObject({ baseUrl: "https://a", headers: { h: "1" } });
    expect(merged[0]?.compat).toEqual({ x: 1, y: 2 });
    expect(base[0]?.compat).toEqual({ x: 1 });
    const parsed = parseChannels(
      "p",
      { channels: { a: { headers: { h: "2" } } as never } },
      {
        channels: base as never,
        defaultChannel: "b",
      },
    );
    expect(parsed.defaultChannel).toBe("b");
    expect(parsed.warnings).toEqual([]);
    expect(parseChannels("p", { channels: { c: { headers: {} } as never } }).warnings).toHaveLength(
      1,
    );
  });

  it("catalogChannels：目录限定的渠道过滤未知名、缺省排前", () => {
    const known = [{ name: "x" }, { name: "y" }, { name: "z" }] as never;
    expect(catalogChannels(undefined, known, "y")).toEqual(["y", "x", "z"]);
    expect(catalogChannels(["z", "nope", "x"], known, "x")).toEqual(["x", "z"]);
    expect(catalogChannels(["z"], known, "x")).toEqual(["z"]);
    expect(catalogChannels(["nope"], known, "x")).toEqual(["x"]);
  });
});

describe("内置目录吃 ama models refresh 的数据", () => {
  it("刷新后的索引覆盖快照数值；缺字段的条目退回内置快照", () => {
    const data = structuredClone(builtinSnapshot());
    const deepseek = data["deepseek"];
    if (deepseek === undefined) throw new Error("snapshot");
    const flash = deepseek.models["deepseek-flash"];
    if (flash === undefined) throw new Error("snapshot");
    flash.limit = { ...flash.limit, context: 777_000 };
    flash.name = "Flash (refreshed)";
    const r = registry({ version: 1 }, { modelsDev: new ModelsDevIndex(data) });
    expect(model(r, "deepseek/deepseek-flash")).toMatchObject({
      contextWindow: 777_000,
      name: "Flash (refreshed)",
    });
    // 名字被上游清掉（缺必填字段）：这一条退回内置快照，启动不失败
    delete (flash as { name?: string }).name;
    const fallback = registry({ version: 1 }, { modelsDev: new ModelsDevIndex(data) });
    expect(model(fallback, "deepseek/deepseek-flash").name).toBe(
      builtinSnapshot()["deepseek"]?.models["deepseek-flash"]?.name,
    );
  });
});
