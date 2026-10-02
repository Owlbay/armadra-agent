import { describe, expect, it } from "vitest";
import { ApiRegistry, createDefaultApiRegistry } from "../ai/apis/api.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import { pickDefaultModel } from "./default-model.js";

function registry(env: Record<string, string>, apis?: ApiRegistry): ProviderRegistry {
  return new ProviderRegistry({
    apis: apis ?? createDefaultApiRegistry(),
    keys: { env, useEnv: true, userAuthFile: null },
  });
}

describe("零配置选模型（设计 §10.0）", () => {
  it("按内置顺序取第一个有 key 的供应商的目录首条", async () => {
    const one = await pickDefaultModel(registry({ DEEPSEEK_API_KEY: "k" }));
    expect(one?.provider.id).toBe("deepseek");
    expect(one?.model.id).toBe(registry({}).get("deepseek")?.models[0]?.id);
    expect(one).toMatchObject({ via: "key", keySource: "env" });
    const two = await pickDefaultModel(registry({ DEEPSEEK_API_KEY: "k", ANTHROPIC_API_KEY: "k" }));
    expect(two?.provider.id).toBe("anthropic");
  });

  it("没有 key：不选 fake；本地服务探测到模型才算可用", async () => {
    const empty = registry({});
    expect(await pickDefaultModel(empty)).toBeUndefined();
    const ollama = empty.get("ollama");
    expect(ollama).toBeDefined();
    empty.addModels("ollama", [{ ...empty.get("fake")!.models[0]!, id: "qwen3:8b" }]);
    expect(await pickDefaultModel(empty)).toMatchObject({
      via: "local",
      model: { provider: "ollama", id: "qwen3:8b" },
    });
  });

  it("协议未实现的供应商跳过", async () => {
    const apis = new ApiRegistry();
    expect(await pickDefaultModel(registry({ ANTHROPIC_API_KEY: "k" }, apis))).toBeUndefined();
  });
});
