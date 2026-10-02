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
