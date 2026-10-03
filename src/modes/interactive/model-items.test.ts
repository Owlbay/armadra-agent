import { afterEach, describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../ai/providers/registry.js";
import type { ProviderData, ProviderRegistryApi } from "../../ai/types.js";
import { clearLiveTokens, registerLiveToken } from "../../auth/oauth/live.js";
import { setLocale } from "../../i18n/index.js";
import { catalogItems, loadModelCatalog, modelDescription, modelItems } from "./model-items.js";

afterEach(() => {
  clearLiveTokens();
  setLocale("zh");
});

function relay(): ProviderRegistry {
  return new ProviderRegistry({
    includeFake: false,
    keys: { env: { RELAY_KEY: "k" }, userAuthFile: null },
    config: {
      version: 1,
      providers: {
        relay: {
          apiKey: "$RELAY_KEY",
          channels: {
            chat: { api: "openai-completions", baseUrl: "https://r.example/v1" },
            messages: { api: "anthropic-messages", baseUrl: "https://r.example" },
          },
          models: [
            {
              id: "kimi-k2.5",
              channels: ["chat", "messages"],
              contextWindow: 262144,
              input: ["text", "image"],
            },
            { id: "glm-5", channels: ["messages"], contextWindow: 1_000_000 },
          ],
        },
      },
    },
  });
}

function model(provider: string, id: string, name = id) {
  return {
    id,
    name,
    provider,
    api: "fake",
    input: ["text"],
    reasoning: false,
    maxTokens: 1000,
  } as ProviderData["models"][number];
}

function provider(id: string, models: string[], requiresApiKey = true): ProviderData {
  return {
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "",
    envKeys: [],
    models: models.map((m) => model(id, m)),
    requiresApiKey,
    builtin: true,
  };
}

/** key 表：`key` 普通 key，`oauth` 已登录，`expired` OAuth 需重新登录；不在表里 = 未配置。 */
function registry(
  providers: ProviderData[],
  keys: Record<string, "key" | "oauth" | "expired">,
): ProviderRegistryApi {
  return {
    list: () => providers,
    get: (id) => providers.find((p) => p.id === id),
    findModel: () => ({ ok: false, reason: "not_found", candidates: [] }) as never,
    resolveApiKey: async (id) => {
      const kind = keys[id];
      if (kind === undefined) return { apiKey: undefined, source: "none" };
      if (kind === "key") return { apiKey: "k", source: "env" };
      const token = `tok-${id}`;
      registerLiveToken(token, {
        provider: id,
        flavor: "siwc",
        ...(kind === "expired" ? { needsLogin: true } : {}),
        refresh: async () => token,
      });
      return { apiKey: token, source: "oauth" };
    },
    getApi: () => undefined,
  };
}

const PROVIDERS = [
  provider("openai", ["gpt-5"]),
  provider("anthropic", ["claude-sonnet", "claude-haiku"]),
  provider("chatgpt", []),
  provider("ollama", ["qwen"], false),
];

describe("modelItems：缺省只列已配置的供应商", () => {
  it("有 key / 本地的供应商列出，未配置的不列；组标题带状态", async () => {
    const items = await modelItems(registry(PROVIDERS, { anthropic: "key" }));
    expect(items.map((i) => [i.value, i.group])).toEqual([
      ["anthropic/claude-sonnet", "anthropic · key ✓"],
      ["anthropic/claude-haiku", "anthropic · key ✓"],
      ["ollama/qwen", "ollama · 本地"],
    ]);
  });

  it("OAuth 已登录算已配置；需重新登录的不算", async () => {
    const providers = [provider("chatgpt", ["gpt-5.5"]), provider("other", ["m"])];
    const items = await modelItems(registry(providers, { chatgpt: "oauth", other: "expired" }));
    expect(items.map((i) => [i.value, i.group])).toEqual([
      ["chatgpt/gpt-5.5", "chatgpt · 已登录 ✓"],
    ]);
    const all = await modelItems(registry(providers, { chatgpt: "oauth", other: "expired" }), {
      view: "all",
    });
    expect(all.at(-1)).toMatchObject({ value: "other/m", group: "other · 需重新登录" });
  });

  it("全部视图：未配置的供应商排后、标「未配置 key」；模型表为空的 chatgpt 给登录提示行", async () => {
    const items = await modelItems(registry(PROVIDERS, { anthropic: "key" }), { view: "all" });
    expect(items.map((i) => i.value)).toEqual([
      "anthropic/claude-sonnet",
      "anthropic/claude-haiku",
      "ollama/qwen",
      "openai/gpt-5",
      "ama:hint:chatgpt",
    ]);
    expect(items[3]?.group).toBe("openai · 未配置 key");
    expect(items[4]).toMatchObject({ label: "运行 ama auth login chatgpt 登录" });
  });

  it("已登录但没缓存模型的 chatgpt：已配置视图里给一行 discover 提示；hints: false 不给", async () => {
    const r = registry(PROVIDERS, { chatgpt: "oauth" });
    const items = await modelItems(r);
    expect(items.find((i) => i.value === "ama:hint:chatgpt")).toEqual({
      value: "ama:hint:chatgpt",
      label: "运行 ama models discover chatgpt 获取模型",
      group: "chatgpt · 已登录 ✓",
    });
    expect((await modelItems(r, { hints: false })).some((i) => i.value.startsWith("ama:"))).toBe(
      false,
    );
  });
});

describe("modelItems：models.enabled 与当前模型", () => {
  it("清单只列清单内（含未配置的供应商）；provider/* 整个供应商", async () => {
    const r = registry(PROVIDERS, { anthropic: "key" });
    expect(
      (await modelItems(r, { enabled: ["anthropic/claude-haiku", "openai/gpt-5"] })).map(
        (i) => i.value,
      ),
    ).toEqual(["anthropic/claude-haiku", "openai/gpt-5"]);
    expect((await modelItems(r, { enabled: ["anthropic/*"] })).map((i) => i.value)).toEqual([
      "anthropic/claude-sonnet",
      "anthropic/claude-haiku",
    ]);
    // 空清单等同不设
    expect(await modelItems(r, { enabled: [] })).toHaveLength(3);
  });

  it("全部视图里清单内的项带「清单内」徽标", async () => {
    const items = await modelItems(registry(PROVIDERS, { anthropic: "key" }), {
      view: "all",
      enabled: ["openai/gpt-5"],
    });
    expect(items.find((i) => i.value === "openai/gpt-5")).toMatchObject({
      badge: "清单内",
      badgeColor: "dim",
    });
    expect(items.find((i) => i.value === "ollama/qwen")?.badge).toBeUndefined();
  });

  it("当前模型不在视图里时置顶一行（组「当前」）；在视图里则不重复", async () => {
    const r = registry(PROVIDERS, { anthropic: "key" });
    const items = await modelItems(r, { enabled: ["ollama/qwen"], current: "openai/gpt-5" });
    expect(items.map((i) => [i.value, i.group])).toEqual([
      ["openai/gpt-5", "当前"],
      ["ollama/qwen", "ollama · 本地"],
    ]);
    const inside = await modelItems(r, { current: "ollama/qwen" });
    expect(inside.filter((i) => i.value === "ollama/qwen")).toHaveLength(1);
    // 注册表里没有的引用（订阅后端的任意 slug）也照样置顶
    expect((await modelItems(r, { current: "chatgpt/gpt-9" }))[0]).toEqual({
      value: "chatgpt/gpt-9",
      label: "chatgpt/gpt-9",
      group: "当前",
    });
  });
});

describe("modelItems：多渠道供应商去重", () => {
  it("每个模型一行（首选渠道），说明列出其它渠道；channels 时再列 @渠道 行", async () => {
    const r = relay();
    const items = (await modelItems(r)).filter((i) => i.value.startsWith("relay/"));
    expect(items).toEqual([
      {
        value: "relay/kimi-k2.5",
        label: "kimi-k2.5",
        group: "relay · key ✓",
        description: "262k · img · 另有 @messages",
      },
      { value: "relay/glm-5", label: "glm-5", group: "relay · key ✓", description: "1M" },
    ]);
    const withChannels = await modelItems(r, { channels: true });
    expect(withChannels.map((i) => i.value)).toEqual([
      "relay/kimi-k2.5",
      "relay/kimi-k2.5@messages",
      "relay/glm-5",
    ]);
    expect(withChannels[1]).toMatchObject({
      label: "kimi-k2.5@messages",
      description: "262k · img",
    });
    const found = r.findModel("relay/kimi-k2.5");
    expect(found.ok && modelDescription({ ...found.model, name: "Kimi" })).toBe(
      "Kimi · 262k · img",
    );
  });

  it("清单里逐字写了 @渠道 的行总是列出", async () => {
    const items = await modelItems(relay(), { enabled: ["relay/kimi-k2.5@messages"] });
    expect(items.map((i) => i.value)).toEqual(["relay/kimi-k2.5@messages"]);
  });

  it("目录只解析一次 key：切视图用 catalogItems 同步生成", async () => {
    let calls = 0;
    const base = registry(PROVIDERS, { anthropic: "key" });
    const counted: ProviderRegistryApi = {
      ...base,
      resolveApiKey: async (id) => {
        calls++;
        return base.resolveApiKey(id);
      },
    };
    const catalog = await loadModelCatalog(counted);
    const before = calls;
    catalogItems(catalog, { view: "all" });
    catalogItems(catalog, { view: "configured", channels: true });
    expect(calls).toBe(before);
    expect(before).toBe(3); // ollama 是本地，不解析 key
  });

  it("en 文案", async () => {
    setLocale("en");
    const items = await modelItems(registry(PROVIDERS, { anthropic: "key" }), {
      view: "all",
      current: "x/y",
    });
    expect(items[0]?.group).toBe("current");
    expect(items.find((i) => i.value === "openai/gpt-5")?.group).toBe("openai · no key configured");
    expect(items.find((i) => i.value === "ollama/qwen")?.group).toBe("ollama · local");
  });
});
