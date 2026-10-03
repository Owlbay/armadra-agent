/**
 * [W6-O] openai-responses 的 ChatGPT 订阅后端：请求体快照（两种 flavor）、请求头、配额、出错恢复与错误映射、
 * 订阅用量。走真实的 ProviderRegistry + auth.json OAuth 条目 + fake 后端。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatGptFlavor, OAuthAuthEntry } from "../../config/types-w6.js";
import { readOAuthEntry, writeOAuthEntry } from "../../auth/oauth/token-store.js";
import { FakeOAuthServer, completedEvents } from "../../auth/testing/fake-oauth.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { AssistantMessage, Model, StreamOptions, TranscriptContext } from "../types.js";
import { setLocale } from "../../i18n/index.js";
import { resetChatGptState, transformChatGptBody } from "./chatgpt-backend.js";
import { openAIResponsesApi } from "./openai-responses.js";

type Json = Record<string, unknown>;
let server: FakeOAuthServer;
beforeEach(() => resetChatGptState());
afterEach(async () => {
  await server.stop();
});

const CONTEXT: TranscriptContext = {
  messages: [
    {
      role: "system",
      timestamp: 0,
      sections: { preamble: "Be brief." },
      toolsAdded: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    },
    { role: "user", content: "hi", timestamp: 0 },
  ],
};

async function setup(
  flavor: ChatGptFlavor,
  entry: Partial<OAuthAuthEntry> = {},
): Promise<{
  run: (extra?: Partial<StreamOptions>) => Promise<AssistantMessage>;
  quotas: unknown[];
  authFile: string;
}> {
  server = new FakeOAuthServer();
  const issuer = await server.start();
  const authFile = join(mkdtempSync(join(tmpdir(), "ama-cb-")), "auth.json");
  writeFileSync(authFile, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
  writeOAuthEntry(authFile, "chatgpt", {
    type: "oauth",
    flavor,
    clientId: flavor === "siwc" ? "oaiapp_1" : "app_x",
    issuer,
    accountId: "acct-1",
    planType: "plus",
    accessToken: "at-MARK-1",
    refreshToken: "rt-1",
    expiresAt: Date.now() + 3_600_000,
    ...entry,
  });
  server.seedRefreshToken("rt-1", flavor === "siwc" ? "oaiapp_1" : "app_x");
  const env = { AMA_CHATGPT_ISSUER: issuer };
  const registry = new ProviderRegistry({
    includeFake: false,
    config: {
      version: 1,
      providers: {
        chatgpt: {
          defaultChannel: flavor,
          channels: {
            [flavor]: {
              api: "openai-responses",
              baseUrl: `${issuer}/${flavor === "siwc" ? "v1" : "codex"}`,
            },
          },
        },
      },
    },
    keys: { authFile, userAuthFile: null, env, oauth: { env } },
  });
  const quotas: unknown[] = [];
  const run = async (extra: Partial<StreamOptions> = {}): Promise<AssistantMessage> => {
    const found = registry.findModel("chatgpt/gpt-6-sol");
    if (!found.ok) throw new Error("model not found");
    const key = await registry.resolveApiKey("chatgpt", found.model.channel);
    const options: StreamOptions = {
      signal: new AbortController().signal,
      sessionId: "sess-1",
      maxTokens: 1000,
      temperature: 0.2,
      cacheRetention: "long",
      thinkingLevel: "high",
      onQuota: (q) => quotas.push(q),
      ...extra,
    };
    if (key.apiKey !== undefined) options.apiKey = key.apiKey;
    return openAIResponsesApi
      .stream({ ...found.model, reasoning: true }, CONTEXT, options)
      .result();
  };
  return { run, quotas, authFile };
}

function lastBody(): Json {
  const requests = server.requests.filter((r) => r.path.endsWith("/responses"));
  return JSON.parse(requests.at(-1)?.body ?? "{}") as Json;
}

function lastHeaders(): Record<string, unknown> {
  return server.requests.filter((r) => r.path.endsWith("/responses")).at(-1)?.headers ?? {};
}

describe("SIWC 后端", () => {
  it("请求体快照：禁用字段删除、store / stream / input 数组、prompt_cache_key；只发 Bearer", async () => {
    const { run } = await setup("siwc");
    const message = await run();
    expect(message.stopReason).toBe("stop");
    const body = lastBody();
    expect(Object.keys(body).sort()).toEqual(
      [
        "include",
        "input",
        "instructions",
        "model",
        "prompt_cache_key",
        "reasoning",
        "store",
        "stream",
        "tools",
      ].sort(),
    );
    expect(body).toMatchObject({
      model: "gpt-6-sol",
      store: false,
      stream: true,
      prompt_cache_key: "sess-1",
      instructions: "Be brief.",
      include: ["reasoning.encrypted_content"],
    });
    expect(Array.isArray(body["input"])).toBe(true);
    const headers = lastHeaders();
    expect(headers["authorization"]).toBe("Bearer at-MARK-1");
    expect(headers["chatgpt-account-id"]).toBeUndefined();
    expect(headers["originator"]).toBeUndefined();
    expect(headers["session-id"]).toBeUndefined();
  });

  it("订阅用量：cost 为 0、billing subscription", async () => {
    const { run } = await setup("siwc");
    const message = await run();
    expect(message.usage).toMatchObject({ billing: "subscription", input: 6, cacheRead: 4 });
    expect(message.usage.cost?.total).toBe(0);
  });

  it("429 subscription_sharing_usage_limit_exceeded → quota_exceeded（不重试，发配额）", async () => {
    const { run, quotas } = await setup("siwc");
    server.responses.push({
      status: 429,
      body: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "x" } },
    });
    const message = await run();
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/^quota_exceeded: .*quota exceeded/);
    expect(message.errorMessage).not.toMatch(/\b429\b/);
    expect(quotas).toEqual([{ primary: { usedPercent: 100 } }]);
    expect(server.requests.filter((r) => r.path.endsWith("/responses"))).toHaveLength(1);
  });

  it("403 not_eligible 不重试；400 unsupported_capability 删字段重试一次", async () => {
    const ctx = await setup("siwc");
    server.responses.push({
      status: 403,
      body: { error: { code: "subscription_sharing_user_not_eligible" } },
    });
    expect((await ctx.run()).errorMessage).toMatch(/^not_eligible: .*403/);
    server.responses.push({
      status: 400,
      body: { error: { code: "subscription_sharing_unsupported_capability", param: "reasoning" } },
    });
    const ok = await ctx.run();
    expect(ok.stopReason).toBe("stop");
    expect(lastBody()["reasoning"]).toBeUndefined();
  });

  it("not_eligible 文案列出原因（套餐 / 工作空间 / 地区或预览期）并提示 codex 方式；zh 与 en", async () => {
    const ctx = await setup("siwc");
    const forbidden = {
      status: 403,
      body: { error: { code: "subscription_sharing_user_not_eligible" } },
    };
    server.responses.push(forbidden);
    const zh = (await ctx.run()).errorMessage ?? "";
    expect(zh).toMatch(/^not_eligible: 这个 ChatGPT 账户不能把套餐额度共享给 ama/);
    for (const part of ["Plus / Pro", "工作空间", "地区受限", "预览期", "Pro 账户仍报此错时最可能"])
      expect(zh).toContain(part);
    expect(zh).toContain("ama auth login chatgpt --flavor codex");
    setLocale("en");
    try {
      server.responses.push(forbidden);
      const en = (await ctx.run()).errorMessage ?? "";
      expect(en).toMatch(/^not_eligible: this ChatGPT account cannot share plan usage/);
      for (const part of ["Plus / Pro", "Workspace", "Region", "preview", "Pro account"])
        expect(en).toContain(part);
      expect(en).toContain("ama auth login chatgpt --flavor codex");
    } finally {
      setLocale("zh");
    }
  });

  it("401 → 强制刷新一次重试；仍 401 → auth_expired", async () => {
    const { run, authFile } = await setup("siwc");
    server.responses.push({
      status: 401,
      body: { error: { code: "subscription_sharing_invalid_user" } },
    });
    const ok = await run();
    expect(ok.stopReason).toBe("stop");
    expect(server.refreshCalls).toBe(1);
    expect(lastHeaders()["authorization"]).toBe(
      `Bearer ${readOAuthEntry(authFile, "chatgpt")?.accessToken}`,
    );
    server.responses.push({ status: 401, body: {} }, { status: 401, body: {} });
    const failed = await run();
    expect(failed.errorMessage).toMatch(/^auth_expired: /);
    expect(JSON.stringify(failed)).not.toContain("MARK");
  });

  it("needsLogin：不发请求直接 auth_expired", async () => {
    const { run } = await setup("siwc", { needsLogin: true });
    const message = await run();
    expect(message.errorMessage).toMatch(/^auth_expired: chatgpt login expired/);
    expect(server.requests.filter((r) => r.path.endsWith("/responses"))).toHaveLength(0);
  });

  it("system 角色 item 改 developer；toolsInNamespace 时工具进 additional_tools", () => {
    const model = { id: "m", provider: "chatgpt" } as Model;
    const out = transformChatGptBody(
      {
        input: [
          { role: "system", content: "s" },
          { role: "user", content: "u" },
        ],
        tools: [{ type: "function", name: "read" }],
        metadata: {},
        user: "x",
      },
      model,
      {
        supportsStore: true,
        supportsReasoningSummary: true,
        chatgptBackend: "siwc",
        toolsInNamespace: true,
      },
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({
      input: [
        { type: "additional_tools", tools: [{ type: "function", name: "read" }] },
        { role: "developer", content: "s" },
        { role: "user", content: "u" },
      ],
      store: false,
      stream: true,
    });
  });
});

describe("codex 后端", () => {
  it("请求体快照与请求头：保留 prompt_cache_key，删 max_output_tokens / temperature / 缓存保留", async () => {
    const { run } = await setup("codex");
    await run();
    const body = lastBody();
    expect(body["max_output_tokens"]).toBeUndefined();
    expect(body["temperature"]).toBeUndefined();
    expect(body["prompt_cache_retention"]).toBeUndefined();
    expect(body["prompt_cache_options"]).toBeUndefined();
    expect(body).toMatchObject({ store: false, stream: true, prompt_cache_key: "sess-1" });
    const headers = lastHeaders();
    expect(headers["chatgpt-account-id"]).toBe("acct-1");
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(headers["session-id"]).toBe("sess-1");
    expect(headers["x-client-request-id"]).toBe("sess-1");
  });

  it("配额：响应头与 codex.rate_limits 事件都变成 onQuota", async () => {
    const { run, quotas } = await setup("codex");
    server.responses.push({
      headers: {
        "x-codex-primary-used-percent": "42",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1790000000",
        "x-codex-secondary-used-percent": "18.5",
      },
      events: completedEvents("ok", [
        {
          type: "codex.rate_limits",
          plan_type: "pro",
          rate_limits: { primary: { used_percent: 43, window_minutes: 300, reset_at: 1790000100 } },
        },
      ]),
    });
    const message = await run();
    expect(message.stopReason).toBe("stop");
    expect(quotas).toEqual([
      {
        primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_790_000_000_000 },
        secondary: { usedPercent: 18.5 },
      },
      {
        planType: "pro",
        primary: { usedPercent: 43, windowMinutes: 300, resetsAt: 1_790_000_100_000 },
      },
    ]);
  });

  it("400 Instructions are not valid → 本会话切 developer 消息重试，之后不再发 instructions", async () => {
    const { run } = await setup("codex");
    server.responses.push({ status: 400, body: { detail: "Instructions are not valid" } });
    expect((await run()).stopReason).toBe("stop");
    const body = lastBody();
    expect(body["instructions"]).toBeUndefined();
    expect((body["input"] as Json[])[0]).toEqual({ role: "developer", content: "Be brief." });
    await run();
    expect(lastBody()["instructions"]).toBeUndefined();
    expect(server.requests.filter((r) => r.path.endsWith("/responses"))).toHaveLength(3);
  });

  it("429 usage_limit_reached → quota_exceeded 带重置时间", async () => {
    const { run, quotas } = await setup("codex");
    server.responses.push({
      status: 429,
      body: { error: { type: "usage_limit_reached", resets_at: 1790000000, plan_type: "plus" } },
    });
    const message = await run();
    expect(message.errorMessage).toContain("quota_exceeded");
    expect(message.errorMessage).toContain("2026-");
    expect(quotas).toEqual([
      { planType: "plus", primary: { usedPercent: 100, resetsAt: 1_790_000_000_000 } },
    ]);
  });

  it("登录 flavor 与渠道不符：不发请求", async () => {
    const { run } = await setup("codex", { flavor: "siwc" });
    const message = await run();
    expect(message.errorMessage).toMatch(/^chatgpt_flavor_mismatch/);
  });
});
