import { describe, expect, it } from "vitest";
import { ApiRegistry, createDefaultApiRegistry } from "../ai/apis/api.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import {
  MIN_DEFAULT_CONTEXT,
  pickByPrice,
  pickDefaultModel,
  pickProviderModel,
} from "./default-model.js";

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

describe("缺省模型的价格规则（pickByPrice / pickProviderModel）", () => {
  const c = (id: string, inputCost?: number, contextWindow?: number, toolCall?: boolean) => ({
    id,
    inputCost,
    contextWindow,
    toolCall,
  });

  it("只看支持工具、上下文 ≥ 64k、有价格（> 0）的；输入价最低，同价取上下文大的，再同取靠前的", () => {
    expect(
      pickByPrice([
        c("pricey", 2, 500_000, true),
        c("no-tools", 0.01, 500_000, false),
        c("tools-unknown", 0.01, 500_000, undefined),
        c("small", 0.02, 32_000, true),
        c("free", 0, 500_000, true),
        c("no-price", undefined, 500_000, true),
        c("cheap", 0.15, 128_000, true),
        c("cheap-big", 0.15, 1_000_000, true),
        c("cheap-big-2", 0.15, 1_000_000, true),
      ]),
    ).toEqual({
      id: "cheap-big",
      reason: "支持工具调用、上下文 ≥ 64k 且有价格的模型里输入价最低（$0.15/M 输入，上下文 1M）",
    });
    expect(pickByPrice([c("edge", 1, MIN_DEFAULT_CONTEXT, true)])?.id).toBe("edge");
    expect(pickByPrice([c("a", 1, 32_000, true), c("b", undefined, 1e6, true)])).toBeUndefined();
  });

  it("自定义供应商按规则挑（不按列表顺序），内置供应商取目录首条；挑不出退回首条并说明", async () => {
    const base = registry({}).get("deepseek")!.models[0]!;
    const model = (id: string, input: number | undefined, contextWindow: number) => ({
      ...base,
      id,
      provider: "relay",
      contextWindow,
      ...(input !== undefined ? { cost: { input, output: 1, cacheRead: 0, cacheWrite: 0 } } : {}),
    });
    const relay = {
      id: "relay",
      name: "relay",
      api: base.api,
      baseUrl: "https://r.example/v1",
      envKeys: [],
      requiresApiKey: true,
      builtin: false,
      models: [
        model("grok", 2, 500_000),
        model("flash", 0.15, 1_000_000),
        model("tiny", 0.01, 8_000),
      ],
    };
    const tools = new Set(["grok", "flash", "tiny"]);
    const stub = {
      list: () => [relay],
      get: () => relay,
      findModel: () => ({ ok: false as const, reason: "not_found" as const, candidates: [] }),
      resolveApiKey: async () => ({ apiKey: "k", source: "auth-file" as const }),
      getApi: () => ({ id: base.api, stream: () => undefined as never }),
      modelMetadata: (_p: string, id: string) => ({
        sources: {} as never,
        looked: true,
        toolCall: tools.has(id),
      }),
    };
    const picked = await pickDefaultModel(stub);
    expect(picked?.model.id).toBe("flash");
    expect(picked?.rule).toContain("输入价最低（$0.15/M 输入，上下文 1M）");
    tools.clear();
    expect(pickProviderModel(stub, relay)).toMatchObject({
      model: { id: "grok" },
      rule: "列表首个模型（没有同时支持工具调用、上下文 ≥ 64k 且有价格的模型）",
    });
    const builtin = await pickDefaultModel(registry({ DEEPSEEK_API_KEY: "k" }));
    expect(builtin?.rule).toBe("内置目录推荐的首个模型");
  });
});
