import { describe, expect, it } from "vitest";
import type { ProviderData } from "../ai/types.js";
import {
  buildProviderRegistry,
  providerConfigOf,
  withExtraProviders,
} from "./compose-providers.js";

const relay: ProviderData = {
  id: "relay",
  name: "Relay",
  api: "openai-completions",
  baseUrl: "https://relay.example/v1",
  envKeys: ["RELAY_KEY"],
  requiresApiKey: true,
  builtin: false,
  models: [
    {
      id: "a",
      name: "a",
      provider: "relay",
      api: "openai-completions",
      input: ["text"],
      reasoning: false,
      maxTokens: 8192,
    },
    {
      id: "b",
      name: "b",
      provider: "relay",
      api: "openai-responses",
      input: ["text"],
      reasoning: false,
      maxTokens: 8192,
    },
  ],
};

describe("SDK 供应商折成 config 条目", () => {
  it("模型协议与供应商相同时省略 api，不同时保留模型级 api", () => {
    const config = providerConfigOf(relay);
    expect(config.models?.map((m) => [m.id, m.api])).toEqual([
      ["a", undefined],
      ["b", "openai-responses"],
    ]);
    expect(withExtraProviders({ version: 1 }, [relay]).providers?.["relay"]?.api).toBe(
      "openai-completions",
    );
  });
});

describe("buildProviderRegistry：环境变量 baseUrl", () => {
  const input = (authEnv: boolean, modelRef = "openai/deepseek-v4-flash") => ({
    config: { version: 1 as const },
    cwd: "/w",
    authFile: "/nonexistent/auth.json",
    authEnv,
    cliApiKey: { apiKey: "sk-cli", modelRef },
  });
  const options = {
    env: { OPENAI_BASE_URL: "https://relay.example/v1" },
    includeFake: false,
    probeLocal: false,
  };

  it("OPENAI_BASE_URL 指向中转：目录外的 id 可用，--api-key 落到 openai", async () => {
    const registry = await buildProviderRegistry(input(true), options);
    const found = registry.findModel("openai/deepseek-v4-flash");
    expect(found.ok && found.model.baseUrl).toBe("https://relay.example/v1");
    expect(registry.baseUrlEnv("openai")).toBe("OPENAI_BASE_URL");
    expect(await registry.resolveApiKey("openai")).toMatchObject({ apiKey: "sk-cli" });
  });

  it("profile.authEnv=false 时不读环境变量 baseUrl", async () => {
    const registry = await buildProviderRegistry(input(false), options);
    expect(registry.get("openai")?.baseUrl).toBe("https://api.openai.com/v1");
    expect(registry.findModel("openai/deepseek-v4-flash")).toMatchObject({ ok: false });
  });
});

describe("[W6-O] chatgpt 渠道", () => {
  it("缺省渠道按 auth.json 条目的 flavor；AMA_CHATGPT_BASE_URL 与 originator 改对应渠道", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { withChatGptChannels } = await import("./compose-providers.js");
    const authFile = join(mkdtempSync(join(tmpdir(), "ama-cp-")), "auth.json");
    const base = { version: 1 as const };
    expect(withChatGptChannels(base, authFile, {})).toBe(base);
    writeFileSync(
      authFile,
      JSON.stringify({
        version: 1,
        providers: {
          chatgpt: {
            type: "oauth",
            flavor: "codex",
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 0,
          },
        },
      }),
    );
    const patched = withChatGptChannels(
      { ...base, auth: { chatgpt: { originator: "ama" } } },
      authFile,
      { AMA_CHATGPT_BASE_URL: "http://127.0.0.1:9/codex" },
    );
    expect(patched.providers?.["chatgpt"]).toEqual({
      defaultChannel: "codex",
      channels: {
        codex: {
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9/codex",
          headers: { originator: "ama" },
        },
      },
    });
    const kept = withChatGptChannels(
      { ...base, providers: { chatgpt: { defaultChannel: "siwc" } } },
      authFile,
      {},
    );
    expect(kept.providers?.["chatgpt"]?.defaultChannel).toBe("siwc");
  });
});

describe("max_tokens 上限缓存（#152）", () => {
  it("给了 dataDir 时载回 <dataDir>/models/max-tokens-caps.json", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { maxTokensCaps } = await import("../ai/apis/max-tokens.js");
    const dataDir = mkdtempSync(join(tmpdir(), "ama-cp-caps-"));
    mkdirSync(join(dataDir, "models"));
    writeFileSync(
      join(dataDir, "models", "max-tokens-caps.json"),
      JSON.stringify({ version: 1, caps: { "relay/a": { cap: 4096, learnedAt: Date.now() } } }),
    );
    maxTokensCaps.clear();
    await buildProviderRegistry(
      {
        config: { version: 1 },
        cwd: "/w",
        authFile: join(dataDir, "auth.json"),
        authEnv: false,
        dataDir,
      },
      { includeFake: false, probeLocal: false },
    );
    expect(maxTokensCaps.get("relay/a")).toBe(4096);
    maxTokensCaps.clear();
    const { attachMaxTokensCache } = await import("../ai/providers/max-tokens-cache.js");
    attachMaxTokensCache(dataDir)();
  });
});
