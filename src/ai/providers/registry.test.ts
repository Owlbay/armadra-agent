import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AmaConfig } from "../../config/types.js";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { ProviderRegistry, discoverLocalModels } from "./registry.js";

let tmp: TmpHome;
beforeEach(() => {
  tmp = createTmpHome();
});
afterEach(() => {
  tmp.cleanup();
  vi.unstubAllGlobals();
});

function registry(config?: AmaConfig, env: Record<string, string> = {}): ProviderRegistry {
  return new ProviderRegistry({
    config,
    keys: { env, userAuthFile: join(tmp.configDir, "auth.json") },
  });
}

describe("ProviderRegistry", () => {
  it("13 家内置 + fake；模型已物化（baseUrl / authHeader / requiresApiKey / headers）", () => {
    const r = registry();
    expect(r.list().map((p) => p.id)).toEqual([
      "anthropic",
      "openai",
      "google",
      "deepseek",
      "moonshot",
      "zhipu",
      "dashscope",
      "openrouter",
      "groq",
      "xai",
      "mistral",
      "ollama",
      "lmstudio",
      "fake",
    ]);
    const lookup = r.findModel("anthropic/claude-sonnet-4-6");
    expect(lookup.ok && lookup.model).toMatchObject({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      authHeader: "x-api-key",
      requiresApiKey: true,
      contextWindow: 1_000_000,
    });
    const router = r.findModel("openrouter/anthropic/claude-sonnet-5.5");
    expect(router.ok && router.model.headers).toMatchObject({ "X-Title": "ama" });
    expect(r.findModel("fake/echo")).toMatchObject({ ok: true, model: { requiresApiKey: false } });
    expect(r.modelSource("anthropic", "claude-sonnet-4-6")).toBe("builtin");
  });

  it("引用解析：无前缀唯一匹配、前缀不是供应商时整串当 id、找不到给相近候选", () => {
    const r = registry();
    expect(r.findModel("claude-haiku-4-5")).toMatchObject({
      ok: true,
      provider: { id: "anthropic" },
    });
    expect(r.findModel("qwen/qwen3.8-27b")).toMatchObject({ ok: true, provider: { id: "groq" } });
    const missing = r.findModel("anthropic/claude-sonnet-9");
    expect(missing).toMatchObject({ ok: false, reason: "not_found" });
    const fuzzy = r.findModel("haiku");
    expect(!fuzzy.ok && fuzzy.candidates).toContain("anthropic/claude-haiku-4-5");
  });

  it("同名模型多家都有：只剩一家配置了 key 时选它，否则 ambiguous", () => {
    const config: AmaConfig = {
      version: 1,
      providers: {
        "proxy-a": { baseUrl: "https://a.example/v1", models: [{ id: "shared" }] },
        "proxy-b": { baseUrl: "https://b.example/v1", models: [{ id: "shared" }] },
      },
    };
    const ambiguous = registry(config).findModel("shared");
    expect(ambiguous).toMatchObject({
      ok: false,
      reason: "ambiguous",
      candidates: ["proxy-a/shared", "proxy-b/shared"],
    });
    const keyed = registry(config, { AMA_API_KEY_PROXY_B: "k" }).findModel("shared");
    expect(keyed).toMatchObject({ ok: true, provider: { id: "proxy-b" } });
  });

  it("模型表为空的供应商接受任意 id，按自定义缺省合成", () => {
    const lookup = registry().findModel("ollama/qwen3:8b");
    expect(lookup.ok && lookup.model).toMatchObject({
      id: "qwen3:8b",
      maxTokens: 8192,
      reasoning: false,
      requiresApiKey: false,
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(lookup.ok && lookup.model.contextWindow).toBeUndefined();
  });

  it("config 合并：自定义供应商、内置覆盖、models 替换 / 追加、modelOverrides、无 baseUrl 警告", () => {
    const config: AmaConfig = {
      version: 1,
      providers: {
        "my-proxy": {
          baseUrl: "https://proxy.example/v1",
          apiKey: "$MY_PROXY_KEY",
          models: [{ id: "gpt-x", contextWindow: 128000, maxTokens: 16384, reasoning: true }],
          compat: { maxTokensField: "max_tokens" },
        },
        deepseek: {
          headers: { "X-Org": "o" },
          modelOverrides: [
            { id: "deepseek-flash", contextWindow: 131072 },
            { id: "nope", contextWindow: 1 },
          ],
          models: [{ id: "deepseek-custom" }],
        },
        broken: { models: [{ id: "x" }] },
      },
    };
    const r = registry(config);
    const custom = r.get("my-proxy");
    expect(custom).toMatchObject({
      api: "openai-completions",
      builtin: false,
      envKeys: ["AMA_API_KEY_MY_PROXY"],
      requiresApiKey: true,
    });
    const gptx = r.findModel("my-proxy/gpt-x");
    expect(gptx.ok && gptx.model).toMatchObject({
      name: "gpt-x",
      input: ["text"],
      compat: { maxTokensField: "max_tokens" },
      baseUrl: "https://proxy.example/v1",
    });
    expect(r.modelSource("my-proxy", "gpt-x")).toBe("config");
    const flash = r.findModel("deepseek/deepseek-flash");
    expect(flash.ok && flash.model).toMatchObject({
      contextWindow: 131072,
      headers: { "X-Org": "o" },
    });
    expect(flash.ok && flash.model.cost?.input).toBe(0.3);
    expect(r.findModel("deepseek/deepseek-custom")).toMatchObject({
      ok: true,
      model: { maxTokens: 8192 },
    });
    expect(r.get("broken")).toBeUndefined();
    expect(r.warnings).toEqual([
      'modelOverrides: "deepseek/nope" not found; ignored',
      'provider "broken" in config.json has no baseUrl; ignored',
    ]);
  });

  it("resolveApiKey：config 的 $ENV 走 key 发现；auth.json 的 baseUrl 覆盖供应商", async () => {
    tmp.write(
      "home/.config/ama/auth.json",
      {
        version: 1,
        providers: { openai: { apiKey: "sk-file", baseUrl: "https://gw.example/v1" } },
      },
      0o600,
    );
    const config: AmaConfig = {
      version: 1,
      providers: { "my-proxy": { baseUrl: "https://p/v1", apiKey: "$MY_PROXY_KEY" } },
    };
    const r = registry(config, { MY_PROXY_KEY: "sk-env" });
    expect(await r.resolveApiKey("my-proxy")).toEqual({ apiKey: "sk-env", source: "config" });
    expect(await r.resolveApiKey("openai")).toMatchObject({
      apiKey: "sk-file",
      source: "auth-file",
    });
    const gpt = r.findModel("openai/gpt-5.4");
    expect(gpt.ok && gpt.model.baseUrl).toBe("https://gw.example/v1");
    expect(await r.resolveApiKey("ollama")).toEqual({ apiKey: undefined, source: "none" });
    expect(await r.resolveApiKey("nope")).toEqual({ apiKey: undefined, source: "none" });
    expect(r.hasConfiguredKey("openai")).toBe(true);
    expect(r.hasConfiguredKey("anthropic")).toBe(false);
  });

  it("getApi：四条内置协议 + fake；未知协议 undefined", () => {
    const r = registry();
    expect(r.getApi("anthropic-messages")?.id).toBe("anthropic-messages");
    expect(r.getApi("openai-completions")?.id).toBe("openai-completions");
    expect(r.getApi("openai-responses")?.id).toBe("openai-responses");
    expect(r.getApi("google-generative-ai")?.id).toBe("google-generative-ai");
    expect(r.getApi("fake")?.id).toBe("fake");
    expect(r.getApi("bedrock-converse-stream")).toBeUndefined();
  });

  it("目录项级 api：openai / xai 推理模型走 Responses，其余随供应商", () => {
    const r = registry();
    const api = (ref: string): string | undefined => {
      const found = r.findModel(ref);
      return found.ok ? found.model.api : undefined;
    };
    expect(api("openai/gpt-5.5")).toBe("openai-responses");
    expect(api("openai/o3")).toBe("openai-responses");
    expect(api("openai/gpt-4o")).toBe("openai-completions");
    expect(api("xai/grok-4.7")).toBe("openai-responses");
    expect(api("google/gemini-3.1-pro-preview")).toBe("google-generative-ai");
    expect(r.get("openai")?.api).toBe("openai-completions");
    for (const provider of r.list()) {
      for (const model of provider.models) expect(r.getApi(model.api), model.id).toBeDefined();
    }
  });

  it("addModels 与 discoverLocalModels（ollama /api/tags、OpenAI 兼容 /models）", async () => {
    const r = registry();
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).endsWith("/api/tags")
        ? Response.json({ models: [{ name: "llama3:8b" }, { name: "qwen3:8b" }] })
        : Response.json({ data: [{ id: "local-a" }] }),
    );
    const ollama = r.get("ollama");
    const lmstudio = r.get("lmstudio");
    if (!ollama || !lmstudio) throw new Error("missing");
    const found = await discoverLocalModels(ollama);
    expect(found.map((m) => m.id)).toEqual(["llama3:8b", "qwen3:8b"]);
    expect((await discoverLocalModels(lmstudio)).map((m) => m.id)).toEqual(["local-a"]);
    r.addModels("ollama", found);
    expect(r.modelSource("ollama", "llama3:8b")).toBe("discovered");
    expect(r.findModel("llama3:8b")).toMatchObject({ ok: true, model: { requiresApiKey: false } });
  });
});
