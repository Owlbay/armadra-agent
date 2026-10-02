/**
 * scripts/channel-probe.mjs 用 fake 走通（`fake/echo@messages`，不联网）：一个「看上下文作答」的假协议
 * 照着提示读文件、带签名的思考块、第二次报缓存读。
 */

import { describe, expect, it } from "vitest";
import { createDefaultApiRegistry } from "../apis/api.js";
import { createOutput } from "../apis/shared.js";
import type {
  ApiImplementation,
  AssistantMessage,
  Message,
  Model,
  StreamOptions,
  TranscriptContext,
} from "../types.js";
import { ProviderRegistry } from "./registry.js";
import {
  MAX_REQUESTS_PER_MODEL,
  fixedPrefix,
  probeModel,
  renderTable,
} from "../../../scripts/channel-probe.mjs";

interface Behavior {
  /** 工具调用 id 的生成（缺省每次不同）。 */
  id?: (n: number) => string;
  /** 缓存第二次读到的 token。 */
  cacheRead?: number;
  /** 思考块带签名。 */
  signed?: boolean;
}

function lastUser(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return typeof m.content === "string" ? m.content : "";
  }
  return "";
}

/** 读上下文作答的假协议：提示里的路径 → read 调用；有工具结果 → 拼口令作答。 */
function smartFake(behavior: Behavior = {}): ApiImplementation & { calls: number } {
  let n = 0;
  let cacheCalls = 0;
  const impl = {
    id: "fake" as const,
    calls: 0,
    stream(model: Model, context: TranscriptContext, options: StreamOptions) {
      impl.calls++;
      const out: AssistantMessage = createOutput(model);
      const messages = context.messages;
      const prompt = lastUser(messages);
      const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
      const results = messages.slice(lastUserIndex).filter((m) => m.role === "toolResult");
      const isCache = messages.some(
        (m) => m.role === "system" && typeof m.sections["reference"] === "string",
      );
      if (options.thinkingLevel !== "off" && model.reasoning)
        out.content.push({
          type: "thinking",
          thinking: "plan",
          ...(behavior.signed !== false ? { thinkingSignature: "sig" } : {}),
        });
      if (isCache) {
        cacheCalls++;
        out.content.push({ type: "text", text: "ok" });
        out.usage.cacheReported = true;
        out.usage.cacheRead = cacheCalls > 1 ? (behavior.cacheRead ?? 2900) : 0;
        out.usage.input = cacheCalls > 1 ? 100 - 0 : 3000;
      } else if (results.length > 0) {
        const phrase = results
          .map((r) => String(r.content))
          .map((c) => c.split(": ")[1]?.trim() ?? "")
          .join("");
        out.content.push({ type: "text", text: phrase });
      } else if (prompt.includes("read tool")) {
        const paths = [...prompt.matchAll(/(\/\S+?\.txt)/g)].map((m) => m[1]);
        for (const path of paths)
          out.content.push({
            type: "toolCall",
            id: behavior.id ? behavior.id(n++) : `call_${n++}`,
            name: "read",
            arguments: { path },
          });
        out.stopReason = "toolUse";
      } else out.content.push({ type: "text", text: "ok" });
      return { result: async () => out } as never;
    },
  };
  return impl;
}

function registryWith(api: ApiImplementation): ProviderRegistry {
  const apis = createDefaultApiRegistry();
  apis.register(api);
  return new ProviderRegistry({
    apis,
    keys: { env: {} },
    config: {
      version: 1,
      providers: {
        fake: {
          requiresApiKey: false,
          channels: {
            messages: { api: "fake" as never, baseUrl: "fake://messages" },
            chat: { api: "fake" as never, baseUrl: "fake://chat" },
          },
          models: [{ id: "echo", reasoning: true, channels: ["messages", "chat"] }],
        },
      },
    },
  });
}

describe("channel-probe（fake）", () => {
  it("fake/echo@messages：四项全过、id 唯一 → 过门；请求数 ≤ 8", async () => {
    const fake = smartFake();
    const result = await probeModel({
      registry: registryWith(fake),
      ref: "fake/echo@messages",
      gapMs: 0,
    });
    expect(result).toMatchObject({
      channel: "messages",
      host: "messages",
      check: { status: "pass" },
      tools: { status: "pass" },
      thinking: { status: "pass" },
      cache: { status: "pass", cacheRead: 2900 },
      idsUnique: true,
      pass: true,
    });
    expect(result.toolIds).toHaveLength(3);
    expect(result.requests).toBe(7);
    expect(result.requests).toBeLessThanOrEqual(MAX_REQUESTS_PER_MODEL);
    expect(fake.calls).toBe(7);
    expect(renderTable([result])).toContain("**过门**");
  });

  it("tool_use.id 跨回合重复 → 未过；缓存读 0 → 未过并注明", async () => {
    const result = await probeModel({
      registry: registryWith(smartFake({ id: (n) => `tool_${n % 2}`, cacheRead: 0 })),
      ref: "fake/echo@chat",
      gapMs: 0,
    });
    expect(result.idsUnique).toBe(false);
    expect(result.cache).toMatchObject({ status: "fail", note: "字段为 0" });
    expect(result.pass).toBe(false);
    const table = renderTable([result]);
    expect(table).toContain("✗ 重复");
    expect(table).toContain("未过");
  });

  it("单模型请求上限生效；找不到的模型 / 渠道记错误、不发请求", async () => {
    const fake = smartFake();
    const capped = await probeModel({
      registry: registryWith(fake),
      ref: "fake/echo@messages",
      gapMs: 0,
      maxRequests: 3,
    });
    expect(capped.requests).toBe(3);
    expect(capped.pass).toBe(false);
    const missing = await probeModel({
      registry: registryWith(fake),
      ref: "fake/echo@responses",
    });
    expect(missing.error).toContain("channel_not_found");
    expect(missing.requests).toBe(0);
  });

  it("固定前缀确定且约为给定 token 数", () => {
    expect(fixedPrefix(1000)).toBe(fixedPrefix(1000));
    expect(fixedPrefix(1000).length).toBeGreaterThanOrEqual(4000);
  });
});
