import { describe, expect, it } from "vitest";
import type { ProviderData } from "../ai/types.js";
import { providerConfigOf, withExtraProviders } from "./compose-providers.js";

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
