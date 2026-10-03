/**
 * ChatGPT 渠道跟随登录方式：会话中途换登录方式后同一会话的下一次请求走新 flavor 的端点；显式 `@渠道` 不跟随，
 * 报友好的 mismatch；会话里记录的渠道恢复时不算显式。走真实注册表 + openai-responses + fake 后端。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetChatGptState } from "../../ai/apis/chatgpt-backend.js";
import { ProviderRegistry } from "../../ai/providers/registry.js";
import type { AssistantMessage, Model, ProviderData } from "../../ai/types.js";
import { AgentSessionImpl } from "../../agent/session.js";
import { emptyArgs } from "../../cli/args.js";
import type { RuntimeDeps } from "../../cli/deps.js";
import { resolveModel } from "../../cli/startup-steps.js";
import type { ChatGptFlavor } from "../../config/types-w6.js";
import { SessionManager } from "../../session/manager.js";
import { clearLiveTokens, registerLiveToken } from "../oauth/live.js";
import { writeOAuthEntry } from "../oauth/token-store.js";
import { FakeOAuthServer } from "../testing/fake-oauth.js";
import { followChatGptLogin } from "./follow.js";

let server: FakeOAuthServer | undefined;
beforeEach(() => resetChatGptState());
afterEach(async () => {
  clearLiveTokens();
  await server?.stop();
  server = undefined;
});

function login(authFile: string, issuer: string, flavor: ChatGptFlavor): void {
  writeOAuthEntry(authFile, "chatgpt", {
    type: "oauth",
    flavor,
    clientId: flavor === "siwc" ? "oaiapp_1" : "app_x",
    issuer,
    accountId: "acct-1",
    planType: "pro",
    accessToken: `at-${flavor}`,
    refreshToken: `rt-${flavor}`,
    expiresAt: Date.now() + 3_600_000,
  });
}

async function setup(flavor: ChatGptFlavor) {
  server = new FakeOAuthServer();
  const issuer = await server.start();
  const authFile = join(mkdtempSync(join(tmpdir(), "ama-follow-")), "auth.json");
  writeFileSync(authFile, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
  login(authFile, issuer, flavor);
  const env = { AMA_CHATGPT_ISSUER: issuer };
  const registry = new ProviderRegistry({
    includeFake: false,
    config: {
      version: 1,
      providers: {
        chatgpt: {
          defaultChannel: flavor,
          channels: {
            siwc: { api: "openai-responses", baseUrl: `${issuer}/v1` },
            codex: { api: "openai-responses", baseUrl: `${issuer}/codex` },
          },
        },
      },
    },
    keys: { authFile, userAuthFile: null, env, oauth: { env } },
  });
  const session = (ref: string, manager = SessionManager.inMemory("/work")) => {
    const found = registry.findModel(ref);
    if (!found.ok) throw new Error(`model ${ref} missing`);
    return new AgentSessionImpl({
      model: found.model,
      sessionManager: manager,
      providers: registry,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 },
    });
  };
  const responses = () =>
    server!.requests.filter((r) => r.path.endsWith("/responses")).map((r) => r.path);
  return { issuer, authFile, registry, session, responses };
}

function lastAssistant(session: AgentSessionImpl): AssistantMessage | undefined {
  return session.manager
    .branch()
    .flatMap((e) => (e.type === "message" && e.message.role === "assistant" ? [e.message] : []))
    .at(-1) as AssistantMessage | undefined;
}

describe("渠道跟随登录方式", () => {
  it("siwc 登录选的模型，换成 codex 登录后同一会话的下一次请求走 codex 端点（不用重启）", async () => {
    const h = await setup("siwc");
    const session = h.session("chatgpt/gpt-6-astra");
    await session.prompt("one");
    expect(lastAssistant(session)?.stopReason).toBe("stop");
    expect(h.responses()).toEqual(["/v1/responses"]);
    expect(server!.requests.at(-1)?.headers["originator"]).toBeUndefined();

    login(h.authFile, h.issuer, "codex");
    await session.prompt("two");
    expect(lastAssistant(session)?.stopReason).toBe("stop");
    expect(h.responses()).toEqual(["/v1/responses", "/codex/responses"]);
    const codex = server!.requests.at(-1);
    expect(codex?.headers["authorization"]).toBe("Bearer at-codex");
    expect(codex?.headers["chatgpt-account-id"]).toBe("acct-1");
    expect(codex?.headers["originator"]).toBe("codex_cli_rs");

    // 再换回 siwc：codex 的 originator 头不跟过去
    login(h.authFile, h.issuer, "siwc");
    await session.prompt("three");
    expect(h.responses().at(-1)).toBe("/v1/responses");
    expect(server!.requests.at(-1)?.headers["originator"]).toBeUndefined();
  });

  it("显式 @siwc 在 codex 登录下不跟随：不发请求，报友好的 mismatch", async () => {
    const h = await setup("codex");
    // 表外 slug 按所写渠道直接物化（不留缺省渠道的地址与 compat）
    const found = h.registry.findModel("chatgpt/gpt-6-astra@siwc");
    expect(found.ok && found.model).toMatchObject({
      baseUrl: `${h.issuer}/v1`,
      channel: "siwc",
      channelPinned: true,
      compat: { chatgptBackend: "siwc" },
    });
    const session = h.session("chatgpt/gpt-6-astra@siwc");
    await session.prompt("one");

    const message = lastAssistant(session);
    expect(message?.stopReason).toBe("error");
    expect(message?.errorMessage).toBe(
      "chatgpt_flavor_mismatch: 当前以 codex 方式登录，但 chatgpt/gpt-6-astra@siwc 显式指定了 @siwc 渠道。" +
        "去掉 @siwc 让渠道跟随登录方式，或运行 ama auth login chatgpt --flavor siwc",
    );
    expect(h.responses()).toEqual([]);
  });

  it("恢复会话：记录的渠道（换登录前的 siwc）不算显式，按当前登录解析并跟随", async () => {
    const h = await setup("siwc");
    const manager = SessionManager.inMemory("/work");
    const first = h.session("chatgpt/gpt-6-astra", manager);
    await first.prompt("one");
    expect(manager.branch().find((e) => e.type === "model_change")).toMatchObject({
      channel: "siwc",
    });
    login(h.authFile, h.issuer, "codex");
    const choice = await resolveModel(
      emptyArgs(),
      h.registry,
      manager,
      undefined,
      {} as RuntimeDeps,
      false,
    );
    expect(choice.model.channelPinned).toBeUndefined();
    const resumed = new AgentSessionImpl({
      model: choice.model,
      sessionManager: manager,
      providers: h.registry,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 },
    });
    await resumed.prompt("two");
    expect(lastAssistant(resumed)?.stopReason).toBe("stop");
    expect(h.responses().at(-1)).toBe("/codex/responses");
  });
});

describe("followChatGptLogin", () => {
  const provider = {
    id: "chatgpt",
    channels: [
      {
        name: "siwc",
        api: "openai-responses",
        baseUrl: "https://s",
        compat: { chatgptBackend: "siwc" },
      },
      {
        name: "codex",
        api: "openai-responses",
        baseUrl: "https://c",
        headers: { originator: "codex_cli_rs" },
        compat: { chatgptBackend: "codex" },
      },
    ],
  } as unknown as ProviderData;
  const model = {
    id: "m",
    provider: "chatgpt",
    api: "openai-responses",
    baseUrl: "https://s",
    channel: "siwc",
    compat: { chatgptBackend: "siwc", sendPromptCacheKey: true },
  } as unknown as Model;

  it("不是订阅后端、不是 OAuth token、flavor 一致、显式渠道：原样返回", () => {
    registerLiveToken("tok", { provider: "chatgpt", flavor: "codex", refresh: async () => "" });
    const plain = { ...model, compat: {} } as Model;
    expect(followChatGptLogin(plain, provider, "tok")).toBe(plain);
    expect(followChatGptLogin(model, provider, "api-key")).toBe(model);
    expect(followChatGptLogin(model, provider, undefined)).toBe(model);
    const pinned = { ...model, channelPinned: true };
    expect(followChatGptLogin(pinned, provider, "tok")).toBe(pinned);
    registerLiveToken("tok2", { provider: "chatgpt", flavor: "siwc", refresh: async () => "" });
    expect(followChatGptLogin(model, provider, "tok2")).toBe(model);
  });

  it("改到登录 flavor 的渠道：端点、渠道头、compat；其它 compat 保留", () => {
    registerLiveToken("tok", { provider: "chatgpt", flavor: "codex", refresh: async () => "" });
    expect(followChatGptLogin(model, provider, "tok")).toMatchObject({
      baseUrl: "https://c",
      channel: "codex",
      headers: { originator: "codex_cli_rs" },
      compat: { chatgptBackend: "codex", sendPromptCacheKey: true },
    });
  });
});
