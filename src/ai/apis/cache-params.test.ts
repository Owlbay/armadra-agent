import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import {
  affinityHeaders,
  effectiveRetention,
  endpointHost,
  resolveCacheRetention,
  resolvePromptCacheCompat,
} from "./cache-params.js";

const at = (baseUrl: string | undefined, compat?: Model["compat"]) =>
  ({ ...(baseUrl === undefined ? {} : { baseUrl }), ...(compat ? { compat } : {}) }) as Pick<
    Model,
    "baseUrl" | "compat"
  >;

describe("resolvePromptCacheCompat：按请求主机推断，显式 compat 覆盖", () => {
  it("官方端点：OpenAI 发键、支持长保留；Anthropic 支持长保留、无键", () => {
    expect(resolvePromptCacheCompat(at("https://api.openai.com/v1"), "openai-completions")).toEqual(
      {
        sendPromptCacheKey: true,
        sendSessionAffinityHeaders: false,
        supportsLongCacheRetention: true,
        supportsExplicitPromptCacheMode: false,
        cacheReporting: "auto",
      },
    );
    // baseUrl 缺省 = 协议的官方地址
    expect(resolvePromptCacheCompat(at(undefined), "openai-responses").sendPromptCacheKey).toBe(
      true,
    );
    const anthropic = resolvePromptCacheCompat(at(undefined), "anthropic-messages");
    expect(anthropic.supportsLongCacheRetention).toBe(true);
    expect(anthropic.sendPromptCacheKey).toBe(false);
  });

  it("中转 / 未列入的国产 / OpenRouter：全部缺省关；provider id 不参与（openai 指到中转按中转）", () => {
    for (const url of [
      "https://www.packyapi.com/v1",
      "https://open.bigmodel.cn/api/paas/v4",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://api.groq.com/openai/v1",
      "https://openrouter.ai/api/v1",
      "https://api.openai.com.evil.test/v1",
      "not a url",
    ]) {
      const compat = resolvePromptCacheCompat(at(url), "openai-completions");
      expect(compat.sendPromptCacheKey).toBe(false);
      expect(compat.sendSessionAffinityHeaders).toBe(false);
      expect(compat.supportsLongCacheRetention).toBe(false);
    }
    expect(endpointHost(at("not a url"), "openai-completions")).toBe("");
  });

  it.each<[string, boolean, boolean]>([
    // [baseUrl, 发 prompt_cache_key, 长保留]（HOST_CACHE_CAPABILITIES，W5-M2）
    ["https://api.x.ai/v1", true, false],
    ["https://api.mistral.ai/v1", true, false],
    ["https://api.moonshot.cn/v1", true, false],
    ["https://api.moonshot.ai/v1", true, false],
    ["https://tokenhub.tencentmaas.com/v1", true, true],
    ["https://api.deepseek.com", false, false],
  ])("按主机的缓存能力表：%s", (url, key, long) => {
    const compat = resolvePromptCacheCompat(at(url), "openai-responses");
    expect(compat.sendPromptCacheKey).toBe(key);
    expect(compat.supportsLongCacheRetention).toBe(long);
  });

  it("Anthropic 线：腾讯 TokenHub 支持 1h，通义只有 5m；Messages 上永不发 prompt_cache_key", () => {
    const tencent = resolvePromptCacheCompat(
      at("https://tokenhub.tencentmaas.com"),
      "anthropic-messages",
    );
    expect(tencent).toMatchObject({ supportsLongCacheRetention: true, sendPromptCacheKey: false });
    const qwen = resolvePromptCacheCompat(
      at("https://dashscope.aliyuncs.com/apps/anthropic"),
      "anthropic-messages",
    );
    expect(qwen.supportsLongCacheRetention).toBe(false);
    expect(effectiveRetention("long", qwen)).toBe("short");
    expect(effectiveRetention("long", tencent)).toBe("long");
    expect(resolvePromptCacheCompat(at("https://constructor"), "openai-completions")).toMatchObject(
      { sendPromptCacheKey: false },
    );
  });

  it("显式 compat 逐字段覆盖推断", () => {
    const compat = resolvePromptCacheCompat(
      at("https://www.packyapi.com/v1", { sendPromptCacheKey: true, cacheReporting: "silent" }),
      "openai-completions",
    );
    expect(compat.sendPromptCacheKey).toBe(true);
    expect(compat.cacheReporting).toBe("silent");
    const off = resolvePromptCacheCompat(
      at(undefined, { supportsLongCacheRetention: false }),
      "anthropic-messages",
    );
    expect(off.supportsLongCacheRetention).toBe(false);
  });
});

describe("保留层级", () => {
  it("显式值优先；否则 AMA_CACHE_RETENTION；非法值忽略；缺省 short", () => {
    expect(resolveCacheRetention("none", { AMA_CACHE_RETENTION: "long" })).toBe("none");
    expect(resolveCacheRetention(undefined, { AMA_CACHE_RETENTION: " LONG " })).toBe("long");
    expect(resolveCacheRetention(undefined, { AMA_CACHE_RETENTION: "none" })).toBe("none");
    expect(resolveCacheRetention(undefined, { AMA_CACHE_RETENTION: "1h" })).toBe("short");
    expect(resolveCacheRetention(undefined, {})).toBe("short");
  });

  it("long 在不支持长保留的端点降为 short", () => {
    expect(effectiveRetention("long", { supportsLongCacheRetention: false })).toBe("short");
    expect(effectiveRetention("long", { supportsLongCacheRetention: true })).toBe("long");
    expect(effectiveRetention("none", { supportsLongCacheRetention: false })).toBe("none");
  });
});

describe("亲和头", () => {
  const on = { sendSessionAffinityHeaders: true };
  it("开关关（缺省）不发；开后发 x-session-affinity + 每请求 x-client-request-id", () => {
    const relay = at("https://www.packyapi.com/v1");
    expect(affinityHeaders(relay, "openai-completions", "s1", "short")).toEqual({});
    const headers = affinityHeaders(
      at("https://www.packyapi.com/v1", on),
      "openai-completions",
      "s1",
      "short",
      () => "req-1",
    );
    expect(headers).toEqual({ "x-session-affinity": "s1", "x-client-request-id": "req-1" });
  });

  it("OpenRouter 用 x-session-id；无 sessionId 或 retention none 不发", () => {
    const router = at("https://openrouter.ai/api/v1", on);
    expect(affinityHeaders(router, "openai-completions", "s1", "short")).toEqual({
      "x-session-id": "s1",
    });
    expect(affinityHeaders(router, "openai-completions", undefined, "short")).toEqual({});
    expect(affinityHeaders(router, "openai-completions", "s1", "none")).toEqual({});
  });
});
