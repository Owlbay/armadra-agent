import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODELS_DEV_MAX_OUTPUT,
  ModelsDevIndex,
  idCandidates,
  keepForSnapshot,
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
        // 只有 input 没有 output 的价格用不上，整段丢掉
      },
    });
    expect(() => trimModelsDev([])).toThrow();
  });

  it("第五波字段：family / knowledge / release_date / limit.input / 价格档位 / interleaved / beta", () => {
    const trimmed = trimModelsDev({
      acme: {
        id: "acme",
        api: "https://acme.test/v1",
        models: {
          m: {
            name: "M",
            family: "m-family",
            knowledge: "2026-06",
            release_date: "2026-09-01",
            last_updated: "2026-09-02",
            status: "beta",
            interleaved: { field: "reasoning_content", extra: 1 },
            reasoning_options: [{ type: "effort", values: ["low"] }],
            limit: { context: 300_000, input: 250_000, output: 32_000 },
            cost: {
              input: 1,
              output: 2,
              context_over_200k: { input: 2, output: 4, cache_read: 0.2 },
              tiers: [
                { input: 3, output: 6, tier: { type: "context", size: 128_000 } },
                { input: 9, output: 9, tier: { type: "other", size: 1 } },
              ],
            },
          },
          old: { status: "deprecated", interleaved: true },
        },
      },
    });
    expect(trimmed["acme"]).toEqual({
      id: "acme",
      api: "https://acme.test/v1",
      models: {
        m: {
          id: "m",
          name: "M",
          family: "m-family",
          knowledge: "2026-06",
          release_date: "2026-09-01",
          status: "beta",
          interleaved: { field: "reasoning_content" },
          limit: { context: 300_000, input: 250_000, output: 32_000 },
          cost: {
            input: 1,
            output: 2,
            context_over_200k: { input: 2, output: 4, cache_read: 0.2 },
            tiers: [{ input: 3, output: 6, tier: { size: 128_000, type: "context" } }],
          },
        },
        old: { id: "old", interleaved: true },
      },
    });
  });

  it("keepForSnapshot：丢 deprecated、不出文本、context 0 / 缺失、tool_call:false", () => {
    const ok = { limit: { context: 1 }, modalities: { output: ["text"] } };
    expect(keepForSnapshot(ok)).toBe(true);
    expect(keepForSnapshot({ ...ok, status: "beta" })).toBe(true);
    expect(keepForSnapshot({ ...ok, status: "deprecated" })).toBe(false);
    expect(keepForSnapshot({ ...ok, tool_call: false })).toBe(false);
    expect(keepForSnapshot({ ...ok, modalities: { output: ["image"] } })).toBe(false);
    expect(keepForSnapshot({ limit: { context: 0 } })).toBe(false);
    expect(keepForSnapshot({})).toBe(false);
    expect(keepForSnapshot("x")).toBe(false);
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

  it("档位、元数据字段；catalog 口径不封顶、缺缓存价记 0", () => {
    const model = {
      id: "m",
      family: "f",
      knowledge: "2026-06",
      release_date: "2026-09-01",
      status: "beta" as const,
      limit: { context: 1_000_000, input: 900_000, output: 128_000 },
      cost: {
        input: 1,
        output: 2,
        cache_read: 0.1,
        context_over_200k: { input: 2, output: 4 },
      },
    };
    expect(modelsDevFields(model)).toEqual({
      contextWindow: 1_000_000,
      maxTokens: MODELS_DEV_MAX_OUTPUT,
      inputLimit: 900_000,
      family: "f",
      knowledge: "2026-06",
      releaseDate: "2026-09-01",
      status: "beta",
      cost: {
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: 1,
        tiers: [{ inputTokensAbove: 200_000, input: 2, output: 4, cacheRead: 2, cacheWrite: 2 }],
      },
    });
    const catalog = modelsDevFields(model, "catalog");
    expect(catalog.maxTokens).toBe(128_000);
    expect(catalog.cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 200_000, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }],
    });
    // 通用 tiers 优先于 context_over_200k；inputLimit 与 context 相同不给
    const tiered = modelsDevFields(
      {
        id: "t",
        limit: { context: 10, input: 10 },
        cost: {
          input: 1,
          output: 1,
          context_over_200k: { input: 9, output: 9 },
          tiers: [
            { input: 3, output: 3, tier: { size: 500, type: "context" } },
            { input: 2, output: 2, tier: { size: 100, type: "context" } },
          ],
        },
      },
      "catalog",
    );
    expect(tiered.inputLimit).toBeUndefined();
    expect(tiered.cost?.tiers?.map((t) => t.inputTokensAbove)).toEqual([100, 500]);
  });
});
