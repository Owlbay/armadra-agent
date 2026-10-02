import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../ai/providers/registry.js";
import { modelDescription, modelItems } from "./startup-ui.js";

describe("/model 选择器：供应商 · 渠道", () => {
  it("多渠道模型在每个渠道下各一项，非首选渠道带 @；说明里有上下文与 img", async () => {
    const registry = new ProviderRegistry({
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
    const items = (await modelItems(registry)).filter((i) => i.value.startsWith("relay/"));
    expect(items).toEqual([
      {
        value: "relay/kimi-k2.5",
        label: "kimi-k2.5",
        group: "relay · chat · key ✓",
        description: "262k · img",
      },
      {
        value: "relay/kimi-k2.5@messages",
        label: "kimi-k2.5@messages",
        group: "relay · messages · key ✓",
        description: "262k · img",
      },
      {
        value: "relay/glm-5",
        label: "glm-5",
        group: "relay · messages · key ✓",
        description: "1M",
      },
    ]);
    const found = registry.findModel("relay/kimi-k2.5");
    expect(found.ok && modelDescription({ ...found.model, name: "Kimi" })).toBe(
      "Kimi · 262k · img",
    );
  });
});
