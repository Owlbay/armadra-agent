/**
 * [W6-O] ApiKeyResolver 对 auth.json OAuth 条目的解析：绕过 fileCache、刷新、登记活 token、needsLogin。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveToken } from "../../auth/oauth/live.js";
import { readOAuthEntry, writeOAuthEntry } from "../../auth/oauth/token-store.js";
import { FakeOAuthServer } from "../../auth/testing/fake-oauth.js";
import { ApiKeyResolver } from "./auth.js";

const provider = { id: "chatgpt", envKeys: [], requiresApiKey: true };
let server: FakeOAuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function setup(
  expiresAt: number,
): Promise<{ authFile: string; env: Record<string, string> }> {
  server = new FakeOAuthServer();
  const issuer = await server.start();
  const authFile = join(mkdtempSync(join(tmpdir(), "ama-ao-")), "auth.json");
  writeFileSync(authFile, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
  writeOAuthEntry(authFile, "chatgpt", {
    type: "oauth",
    flavor: "codex",
    clientId: "app_x",
    issuer,
    accountId: "acct-9",
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt,
  });
  server.seedRefreshToken("rt-1", "app_x");
  return { authFile, env: { AMA_CHATGPT_ISSUER: issuer } };
}

describe("ApiKeyResolver × OAuth", () => {
  it("新鲜 token：source oauth，登记账户；hasConfiguredKey 为 true", async () => {
    const { authFile, env } = await setup(Date.now() + 3_600_000);
    const resolver = new ApiKeyResolver({ authFile, userAuthFile: null, env, oauth: { env } });
    expect(resolver.hasConfiguredKey(provider)).toBe(true);
    const key = await resolver.resolve(provider);
    expect(key).toEqual({ apiKey: "at-1", source: "oauth", origin: authFile });
    expect(liveToken("at-1")).toMatchObject({
      provider: "chatgpt",
      flavor: "codex",
      accountId: "acct-9",
    });
    // 渠道 id（chatgpt@codex）没有条目
    expect(
      (await resolver.resolve({ id: "chatgpt@codex", envKeys: [], requiresApiKey: true })).apiKey,
    ).toBeUndefined();
  });

  it("每次重读文件（别的进程刷新后立刻可见）；临近过期自动刷新", async () => {
    const { authFile, env } = await setup(Date.now() + 3_600_000);
    const resolver = new ApiKeyResolver({ authFile, userAuthFile: null, env, oauth: { env } });
    await resolver.resolve(provider);
    const stored = readOAuthEntry(authFile, "chatgpt");
    if (stored) writeOAuthEntry(authFile, "chatgpt", { ...stored, accessToken: "at-other" });
    expect((await resolver.resolve(provider)).apiKey).toBe("at-other");
    if (stored) writeOAuthEntry(authFile, "chatgpt", { ...stored, expiresAt: Date.now() });
    const refreshed = await resolver.resolve(provider);
    expect(refreshed.apiKey).not.toBe("at-1");
    expect(server?.refreshCalls).toBe(1);
    // 活 token 的强制刷新
    const live = liveToken(refreshed.apiKey);
    const forced = await live?.refresh();
    expect(forced).not.toBe(refreshed.apiKey);
    expect(server?.refreshCalls).toBe(2);
  });

  it("needsLogin：返回旧 token 并登记 needsLogin（协议层直接报 auth_expired）", async () => {
    const { authFile, env } = await setup(Date.now());
    const stored = readOAuthEntry(authFile, "chatgpt");
    if (stored) writeOAuthEntry(authFile, "chatgpt", { ...stored, needsLogin: true });
    const resolver = new ApiKeyResolver({ authFile, userAuthFile: null, env, oauth: { env } });
    const key = await resolver.resolve(provider);
    expect(key.source).toBe("oauth");
    expect(liveToken(key.apiKey)?.needsLogin).toBe(true);
    expect(server?.refreshCalls).toBe(0);
  });
});
