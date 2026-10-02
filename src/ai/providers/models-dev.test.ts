import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODELS_DEV_MAX_OUTPUT,
  ModelsDevIndex,
  idCandidates,
  matchLabel,
  modelsDevFields,
  trimModelsDev,
  type ModelsDevData,
} from "./models-dev.js";

/** 从 models.dev api.json 裁剪的样本（真实条目，9 个模型 id、43 家供应商）。 */
const SAMPLE = JSON.parse(
  readFileSync(join(process.cwd(), "test/fixtures/models-dev/api-sample.json"), "utf8"),
) as unknown;

const index = new ModelsDevIndex(trimModelsDev(SAMPLE));

function data(entries: Record<string, Record<string, object>>): ModelsDevData {
  const raw: Record<string, unknown> = {};
  for (const [provider, models] of Object.entries(entries))
    raw[provider] = { id: provider, models };
  return trimModelsDev(raw);
}

describe("trimModelsDev", () => {
  it("只留用到的字段，丢掉形状不对的条目", () => {
    const trimmed = trimModelsDev({
      acme: {
        id: "acme",
        name: "Acme",
        env: ["ACME_KEY"],
        models: {
          m1: {
            id: "m1",
            description: "长描述",
            limit: { context: 1000, output: -1 },
            modalities: { input: ["text", "image", 3] },
            cost: { input: 1, output: "x" },
            tool_call: true,
          },
          bad: "not an object",
        },
      },
      broken: { id: "broken" },
    });
    expect(Object.keys(trimmed)).toEqual(["acme"]);
    expect(trimmed["acme"]?.models).toEqual({
      m1: {
        id: "m1",
        tool_call: true,
        modalities: { input: ["text", "image"] },
        limit: { context: 1000 },
        cost: { input: 1 },
      },
    });
    expect(() => trimModelsDev([])).toThrow();
  });
});

describe("idCandidates", () => {
  it("依次去前缀、:后缀、-latest、日期后缀", () => {
    expect(idCandidates("openrouter/Qwen/Qwen3-Max:free")).toEqual([
      "openrouter/qwen/qwen3-max:free",
      "qwen3-max:free",
      "qwen3-max",
    ]);
    expect(idCandidates("claude-sonnet-latest")).toEqual(["claude-sonnet-latest", "claude-sonnet"]);
    expect(idCandidates("qwen3.8-max-0902").at(-1)).toBe("qwen3.8-max");
    expect(idCandidates("claude-x-20250514").at(-1)).toBe("claude-x");
    expect(idCandidates("gpt-x-2024-08-06").at(-1)).toBe("gpt-x");
  });
});

describe("ModelsDevIndex.match（真实样本）", () => {
  it("canonical 指向的原厂条目存在 → 用原厂（不分大小写）", () => {
    const m = index.match("minimax-m2.7");
    expect(m).toMatchObject({ ref: "minimax/MiniMax-M2.7", kind: "canonical" });
    expect(m?.candidates).toBeGreaterThan(5);
    expect(index.match("glm-5")).toMatchObject({ ref: "zhipuai/glm-5", kind: "canonical" });
    expect(index.match("grok-4.7")).toMatchObject({ ref: "xai/grok-4.7", kind: "canonical" });
  });

  it("原厂条目不在 models.dev：只在同一 canonical 的条目里取多数，不把转售商当原厂", () => {
    const m = index.match("kimi-k2.5");
    expect(m?.kind).toBe("consensus");
    expect(m?.ref.startsWith("alibaba")).toBe(false);
    expect(m?.model.limit).toEqual({ context: 262144, output: 262144 });
    expect(m?.warning).toMatch(/取多数/);
    const fields = modelsDevFields(m!.model);
    expect(fields).toMatchObject({ contextWindow: 262144, maxTokens: MODELS_DEV_MAX_OUTPUT });
    expect(fields.input).toEqual(["text", "image"]);
  });

  it("canonical 解析不到时，canonical 的厂商自己的条目优先（deepseek-flash）", () => {
    expect(index.match("deepseek-flash")).toMatchObject({
      ref: "deepseek/deepseek-flash",
      kind: "vendor",
    });
  });

  it("只有一条 → single；日期后缀归一化后匹配", () => {
    expect(index.match("qwen3-vl-flash")).toMatchObject({
      ref: "llmgateway/qwen3-vl-flash",
      kind: "single",
    });
    const dated = index.match("qwen3.8-max-0902");
    expect(dated).toMatchObject({ ref: "alibaba/qwen3.8-max", normalized: "qwen3.8-max" });
    expect(matchLabel(dated)).toBe("原厂 alibaba/qwen3.8-max，按 qwen3.8-max");
  });

  it("显式 provider/model 覆盖；找不到返回 undefined，不回落猜测", () => {
    expect(index.match("kimi-k2.5", "302ai/kimi-k2.5")).toMatchObject({
      ref: "302ai/kimi-k2.5",
      kind: "explicit",
    });
    expect(index.match("kimi-k2.5", "nope/kimi")).toBeUndefined();
  });

  it("未匹配", () => {
    expect(index.match("totally-unknown-model")).toBeUndefined();
    expect(matchLabel(undefined)).toBe("未匹配");
  });
});

describe("ModelsDevIndex.match（构造数据）", () => {
  it("没有 canonical 时按原厂表优先", () => {
    const idx = new ModelsDevIndex(
      data({
        reseller: { "foo-1": { limit: { context: 1 } } },
        mistral: { "foo-1": { limit: { context: 2 } } },
        openai: { "foo-1": { limit: { context: 3 } } },
      }),
    );
    expect(idx.match("FOO-1")).toMatchObject({ ref: "openai/foo-1", kind: "vendor" });
  });

  it("vendor/model 形状的 id 直接命中该供应商的条目", () => {
    const idx = new ModelsDevIndex(
      data({ openai: { "gpt-x": {} }, acme: { "gpt-x": { limit: { context: 9 } } } }),
    );
    expect(idx.match("acme/gpt-x")).toMatchObject({ ref: "acme/gpt-x", kind: "prefix" });
    // 前缀不是 models.dev 供应商：去前缀后按 id 匹配
    expect(idx.match("relay/gpt-x")).toMatchObject({ ref: "openai/gpt-x", normalized: "gpt-x" });
  });

  it("多数一致：取最多的取值；全部一致时没有 warning", () => {
    const idx = new ModelsDevIndex(
      data({
        a: { m: { limit: { context: 100, output: 10 } } },
        b: { m: { limit: { context: 200, output: 10 } } },
        c: { m: { limit: { context: 200, output: 10 } } },
        d: { n: { limit: { context: 5 } } },
        e: { n: { limit: { context: 5 } } },
      }),
    );
    const m = idx.match("m");
    expect(m?.model.limit?.context).toBe(200);
    expect(m?.warning).toContain("3 个条目、2 种取值");
    expect(idx.match("n")?.warning).toBeUndefined();
  });
});

describe("modelsDevFields", () => {
  it("maxTokens = min(output, 64k, context)；缺缓存价按输入价", () => {
    expect(
      modelsDevFields({
        id: "x",
        limit: { context: 32_000, output: 100_000 },
        modalities: { input: ["text"] },
        reasoning: false,
        tool_call: false,
        cost: { input: 1, output: 2 },
      }),
    ).toEqual({
      contextWindow: 32_000,
      maxTokens: 32_000,
      input: ["text"],
      reasoning: false,
      toolCall: false,
      cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
    });
    expect(modelsDevFields({ id: "y", limit: { output: 8000 } })).toEqual({ maxTokens: 8000 });
    expect(modelsDevFields({ id: "z" })).toEqual({});
  });
});
