import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { enrichEntry } from "./enrich.js";
import { MODELS_DEV_MAX_OUTPUT } from "./models-dev.js";
import { builtinSnapshotIndex } from "./models-dev-snapshot.js";
import { ProviderRegistry } from "./registry.js";

const snapshot = () => builtinSnapshotIndex();
const none = () => undefined;

describe("[ME-D] 中转模型继承官方目录（D10）", () => {
  it("deepseek-v4-flash 按别名命中 deepseek/deepseek-flash：只继承固有属性，价格仍来自 models.dev", () => {
    const { entry, metadata } = enrichEntry({ id: "deepseek-v4-flash" }, snapshot);
    expect(metadata.catalog).toBe("deepseek/deepseek-flash");
    expect(entry.thinkingLevelMap).toEqual({
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
    });
    expect(entry.promptCache).toEqual({ minTokens: 2048 });
    expect(entry.promptCache?.short).toBeUndefined();
    expect(entry.compat).toEqual({ requiresReasoningContentOnAssistantMessages: true });
    expect(entry.compat?.thinkingFormat).toBeUndefined();
    expect(metadata.sources.reasoning).toBe("catalog-alias");
    expect(metadata.sources.input).toBe("catalog-alias");
    expect(metadata.sources.cost).toBe("models.dev");
    expect(metadata.match).toMatchObject({ ref: "deepseek/deepseek-flash", kind: "explicit" });
    // 价格是 models.dev 的快照价，不是目录里有意钉住的高峰价
    expect(entry.cost?.input).not.toBe(0.3);
    // 配置专用键不进条目
    expect("catalog" in entry).toBe(false);
  });

  it("用户写了的字段不覆盖；catalog: false 全部不继承；显式 catalog 指定条目", () => {
    const own = enrichEntry(
      {
        id: "deepseek-v4-flash",
        reasoning: false,
        promptCache: { minTokens: 1024 },
        compat: { requiresReasoningContentOnAssistantMessages: false },
      },
      snapshot,
    ).entry;
    expect(own.reasoning).toBe(false);
    expect(own.promptCache).toEqual({ minTokens: 1024 });
    expect(own.compat).toEqual({ requiresReasoningContentOnAssistantMessages: false });

    const off = enrichEntry({ id: "deepseek-v4-flash", catalog: false }, snapshot);
    expect(off.metadata.catalog).toBeUndefined();
    expect(off.entry.thinkingLevelMap).toBeUndefined();
    expect(off.entry.promptCache).toBeUndefined();
    expect("catalog" in off.entry).toBe(false);

    const explicit = enrichEntry(
      { id: "my-relay-name", catalog: "deepseek/deepseek-v4-pro" },
      none,
    );
    expect(explicit.metadata.catalog).toBe("deepseek/deepseek-v4-pro");
    expect(explicit.entry.thinkingLevelMap?.high).toBe("high");
    expect(enrichEntry({ id: "x", catalog: "deepseek/missing" }, none).metadata.catalog).toBe(
      undefined,
    );
  });

  it("思考档后缀（gemini-3.8-flash-low）去掉后唯一命中：继承图片与窗口，不打开思考参数", () => {
    for (const id of ["gemini-3.8-flash-low", "gemini-3.8-flash-tiered"]) {
      const { entry, metadata } = enrichEntry({ id }, snapshot);
      expect(metadata.catalog).toBe("google/gemini-3.8-flash");
      expect(entry.input).toEqual(["text", "image"]);
      expect(entry.contextWindow).toBe(1_048_576);
      expect(entry.reasoning).toBeUndefined();
      expect(entry.thinkingLevelMap).toBeUndefined();
      expect(metadata.sources.reasoning).toBe("default");
    }
    // 没有后缀的同名 id 照常继承思考设置
    expect(enrichEntry({ id: "gemini-3.8-flash" }, snapshot).entry.reasoning).toBe(true);
  });

  it("models.dev 不可用时窗口与输出上限取目录值（输出按 models.dev 口径封顶）", () => {
    const { entry, metadata } = enrichEntry({ id: "deepseek-v4-flash" }, none);
    expect(entry.contextWindow).toBe(1_000_000);
    expect(entry.maxTokens).toBe(MODELS_DEV_MAX_OUTPUT);
    expect(metadata.sources.contextWindow).toBe("catalog-alias");
    expect(metadata.sources.cost).toBe("default");
    // modelsDev: false 时不取目录里来自快照的窗口
    const off = enrichEntry({ id: "deepseek-v4-flash", modelsDev: false }, none).entry;
    expect(off.contextWindow).toBeUndefined();
    expect(off.input).toEqual(["text", "image"]);
  });

  it("未命中的 id 行为不变", () => {
    const { entry, metadata } = enrichEntry({ id: "totally-unknown-model" }, snapshot);
    expect(metadata.catalog).toBeUndefined();
    expect(entry).toEqual({ id: "totally-unknown-model" });
  });
});

describe("[ME-D] 注册表：自定义供应商的模型受益，modelOverrides 的 catalog 键不进 Model", () => {
  let tmp: TmpHome;
  beforeEach(() => {
    tmp = createTmpHome();
  });
  afterEach(() => tmp.cleanup());

  it("packy/deepseek-v4-flash 与合成的 astr/gemini-3.8-flash-high", () => {
    const registry = new ProviderRegistry({
      config: {
        version: 1,
        providers: {
          packy: {
            api: "openai-completions",
            baseUrl: "https://relay.example/v1",
            models: [{ id: "deepseek-v4-flash" }, { id: "kimi-k9", catalog: false }],
            modelOverrides: [{ id: "kimi-k9", catalog: "deepseek/deepseek-flash", name: "K9" }],
          },
        },
      },
      keys: { env: {}, userAuthFile: join(tmp.configDir, "auth.json") },
      modelsDev: builtinSnapshotIndex(),
      includeFake: false,
    });
    const found = registry.findModel("packy/deepseek-v4-flash");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.model.promptCache?.minTokens).toBe(2048);
    expect(found.model.input).toContain("image");
    expect("catalog" in found.model).toBe(false);
    expect(registry.modelMetadata("packy", "deepseek-v4-flash")?.catalog).toBe(
      "deepseek/deepseek-flash",
    );
    const k9 = registry.findModel("packy/kimi-k9");
    expect(k9.ok && "catalog" in k9.model).toBe(false);
    expect(k9.ok && k9.model.name).toBe("K9");
  });
});
