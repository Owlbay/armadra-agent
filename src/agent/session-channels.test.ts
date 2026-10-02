import { describe, expect, it } from "vitest";
import { ApiRegistry } from "../ai/apis/api.js";
import { endpointKey } from "../ai/cache/reporting.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model } from "../ai/types.js";
import { SessionManager } from "../session/manager.js";
import { buildContext } from "../session/projection.js";
import { AgentSessionImpl } from "./session.js";
import { createScriptedApi } from "./testing/scripted-api.js";

function setup() {
  const scripted = createScriptedApi([{ text: "a" }, { text: "b" }]);
  const apis = new ApiRegistry();
  apis.register(scripted.api);
  const api = scripted.api.id;
  const providers = new ProviderRegistry({
    includeFake: false,
    apis,
    keys: { env: { RELAY_KEY: "provider-key", MSG_KEY: "channel-key" }, userAuthFile: null },
    config: {
      version: 1,
      providers: {
        relay: {
          apiKey: "$RELAY_KEY",
          channels: {
            chat: { api, baseUrl: "http://chat.invalid/v1" },
            messages: { api, baseUrl: "http://msg.invalid", apiKey: "$MSG_KEY" },
          },
          models: [{ id: "m", channels: ["chat", "messages"], contextWindow: 100_000 }],
        },
      },
    },
  });
  const found = providers.findModel("relay/m");
  if (!found.ok) throw new Error("model missing");
  const manager = SessionManager.inMemory("/work");
  const session = new AgentSessionImpl({
    model: found.model,
    sessionManager: manager,
    providers,
    retry: { baseDelayMs: 1, maxDelayMs: 5 },
  });
  return { session, manager, scripted };
}

describe("会话：渠道", () => {
  it("请求用所选渠道的地址与 key；setModel(@channel) 记进 model_change 与 state.model", async () => {
    const { session, manager, scripted } = setup();
    await session.prompt("one");
    expect(scripted.calls[0]?.model).toMatchObject({
      baseUrl: "http://chat.invalid/v1",
      channel: "chat",
    });
    expect(scripted.calls[0]?.options.apiKey).toBe("provider-key");
    expect(session.state.model).toEqual({ provider: "relay", id: "m", channel: "chat" });

    await session.setModel("relay/m@messages");
    await session.prompt("two");
    expect(scripted.calls[1]?.model).toMatchObject({
      baseUrl: "http://msg.invalid",
      channel: "messages",
    });
    expect(scripted.calls[1]?.options.apiKey).toBe("channel-key");
    expect(session.state.model).toEqual({ provider: "relay", id: "m", channel: "messages" });
    const changes = manager.branch().filter((e) => e.type === "model_change");
    expect(changes.at(-1)).toMatchObject({ provider: "relay", modelId: "m", channel: "messages" });
    expect(buildContext(manager.branch()).model).toEqual({
      provider: "relay",
      id: "m",
      channel: "messages",
    });
  });

  it("缓存端点键区分渠道；没有渠道时与原来相同", () => {
    const model = { provider: "relay", id: "m" } as Model;
    expect(endpointKey({ model, baseUrl: "http://h/v1" })).toBe("relay|h|m");
    expect(endpointKey({ model: { ...model, channel: "messages" }, baseUrl: "http://h" })).toBe(
      "relay|h|m@messages",
    );
  });
});
