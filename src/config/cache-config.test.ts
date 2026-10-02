/**
 * 第三波契约（W3-C0 ③）的配置部分：`cache` 段、缓存 compat 开关、模型级 `api` 与
 * `promptCache` 的校验与层级处理。缓存逻辑本身在 C1a / C1b。
 */

import { describe, expect, it } from "vitest";
import { mergeConfigLayers, restrictProjectConfig } from "./merge.js";
import { validateConfig } from "./schema.js";
import { DEFAULT_CACHE_CONFIG } from "./types.js";
import type { AmaConfig } from "./types.js";

const diagnostics = (value: unknown) =>
  validateConfig(value).map((d) => `${d.severity}:${d.path}: ${d.message}`);

describe("cache 段（第三波 §1.12）", () => {
  it("合法取值无诊断；缺省值", () => {
    expect(
      validateConfig({
        version: 1,
        cache: {
          warming: "idle",
          retention: "long",
          minSavingsUsd: 0.05,
          missNotices: false,
          warmSubagents: true,
        },
      }),
    ).toEqual([]);
    expect(DEFAULT_CACHE_CONFIG).toEqual({
      warming: "streaming",
      retention: "short",
      minSavingsUsd: 0.05,
      missNotices: true,
      warmSubagents: false,
    });
  });

  it("取值与类型错误给出字段路径，未知子字段只警告", () => {
    expect(
      diagnostics({
        version: 1,
        cache: {
          warming: "always",
          retention: "forever",
          minSavingsUsd: -1,
          missNotices: "yes",
          warmSubagents: 1,
          extra: true,
        },
      }),
    ).toEqual([
      "warning:cache.extra: 未知字段，已忽略",
      "error:cache.warming: 取值应为 off | streaming | idle",
      "error:cache.retention: 取值应为 none | short | long",
      "error:cache.minSavingsUsd: 应在 0–9007199254740991 之间",
      "error:cache.missNotices: 应为布尔值",
      "error:cache.warmSubagents: 应为布尔值",
    ]);
    expect(diagnostics({ version: 1, cache: "streaming" })).toEqual(["error:cache: 应为对象"]);
  });

  it("用户级 ← profile 深合并；项目级整段忽略并 warning（同 permission.allow）", () => {
    const user: AmaConfig = { version: 1, cache: { warming: "idle", minSavingsUsd: 0.1 } };
    const profile: AmaConfig = { version: 1, cache: { warming: "off" } };
    const project: AmaConfig = { version: 1, cache: { warming: "idle", retention: "long" } };
    const result = mergeConfigLayers({ user, profile, project });
    expect(result.config.cache).toEqual({ warming: "off", minSavingsUsd: 0.1 });
    expect(result.warnings.join("\n")).toMatch(/项目级不能设 cache，已忽略/);
    expect(restrictProjectConfig(project, "default").accepted).toEqual({});
    expect(mergeConfigLayers({}).config.cache).toBeUndefined();
  });
});

describe("供应商缓存 compat 开关与模型级 api / promptCache", () => {
  it("合法写法无诊断", () => {
    expect(
      validateConfig({
        version: 1,
        providers: {
          packy: {
            baseUrl: "https://proxy.example/v1",
            compat: {
              sendPromptCacheKey: true,
              sendSessionAffinityHeaders: false,
              supportsLongCacheRetention: false,
              supportsExplicitPromptCacheMode: false,
              cacheReporting: "silent",
              maxTokensField: "max_tokens",
            },
            models: [
              { id: "kimi-k2.5", api: "openai-completions", promptCache: { short: 300 } },
              { id: "MiniMax-M2.7", api: "anthropic-messages" },
            ],
            modelOverrides: [{ id: "kimi-k2.5", promptCache: { minTokens: 1024 } }],
          },
        },
      }),
    ).toEqual([]);
  });

  it("类型错误给出字段路径", () => {
    expect(
      diagnostics({
        version: 1,
        providers: {
          packy: {
            baseUrl: "https://proxy.example/v1",
            compat: { sendPromptCacheKey: "yes", cacheReporting: "never" },
            models: [{ id: "m", api: 1, promptCache: { short: "5m", ttl: 1 } }],
            modelOverrides: [{ id: "m", promptCache: 300 }],
          },
        },
      }),
    ).toEqual([
      "error:providers.packy.compat.sendPromptCacheKey: 应为布尔值",
      "error:providers.packy.compat.cacheReporting: 取值应为 auto | silent | reported",
      "error:providers.packy.models[0].api: 应为字符串",
      "warning:providers.packy.models[0].promptCache.ttl: 未知字段，已忽略",
      "error:providers.packy.models[0].promptCache.short: 应为数字",
      "error:providers.packy.modelOverrides[0].promptCache: 应为对象",
    ]);
  });
});
