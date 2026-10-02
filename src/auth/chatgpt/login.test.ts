import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FlowDeps, LoginStep } from "../oauth/flows.js";
import { FakeOAuthServer, followAuthorize, type FakeOAuthOptions } from "../testing/fake-oauth.js";
import { hostIdPath } from "./host-id.js";
import { loginChatGpt, revokeChatGpt } from "./login.js";
import { authorizeUrl, resolveChatGptPreset } from "./presets.js";

let server: FakeOAuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function setup(options: FakeOAuthOptions = {}): Promise<{
  env: Record<string, string>;
  dataDir: string;
  steps: LoginStep[];
  deps: (paste?: (url: string) => string) => FlowDeps;
}> {
  server = new FakeOAuthServer(options);
  const issuer = await server.start();
  const steps: LoginStep[] = [];
  let pasteUrl = "";
  return {
    env: { AMA_CHATGPT_ISSUER: issuer },
    dataDir: mkdtempSync(join(tmpdir(), "ama-o-")),
    steps,
    deps: (paste) => ({
      fetch: (input, init) => fetch(input, init),
      openBrowser: async (url) => {
        void followAuthorize(url);
        return true;
      },
      onStep: (step) => {
        steps.push(step);
        if (step.kind === "paste_prompt") pasteUrl = step.url;
      },
      readLine: async () => {
        // 模拟用户：打开授权 URL，拿 302 的 location 粘回来
        const res = await fetch(pasteUrl, { redirect: "manual" });
        const location = res.headers.get("location") ?? "";
        return paste ? paste(location) : location;
      },
      sleep: async () => {},
    }),
  };
}

describe("SIWC 登录（缺省）", () => {
  it("首次注册：授权参数、换 token、验签、签发 id 入条目；host id 稳定且 0600", async () => {
    const ctx = await setup({ issuedClientId: "oaiapp_X1" });
    const entry = await loginChatGpt({
      flavor: "siwc",
      method: "browser",
      env: ctx.env,
      dataDir: ctx.dataDir,
      port: 0,
      deps: ctx.deps(),
    });
    expect(entry).toMatchObject({
      type: "oauth",
      flavor: "siwc",
      clientId: "oaiapp_X1",
      accountId: "user-sub-1",
      planType: "plus",
      email: "alice@example.com",
    });
    expect(entry.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    const authorize = server?.requests.find((r) => r.path === "/api/accounts/authorize");
    const q = authorize?.query;
    expect(q?.get("client_id")).toBe("dynamic_agent_client");
    expect(q?.get("agent_name_hint")).toBe("ama");
    expect(q?.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(q?.get("resource")).toBe("https://api.openai.com/v1");
    expect(q?.get("code_challenge_method")).toBe("S256");
    expect(q?.get("nonce")?.length).toBeGreaterThan(20);
    expect(q?.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(q?.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    const token = server?.requests.find((r) => r.path === "/api/accounts/oauth/token");
    expect(String(token?.headers["content-type"])).toContain("x-www-form-urlencoded");
    const form = new URLSearchParams(token?.body);
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(form.get("client_id")).toBe("oaiapp_X1");
    const hostFile = hostIdPath(ctx.dataDir);
    const hostId = (JSON.parse(readFileSync(hostFile, "utf8")) as { hostId: string }).hostId;
    expect(hostId).toBe(q?.get("ext_agent_host_id"));
    if (process.platform !== "win32") expect(statSync(hostFile).mode & 0o777).toBe(0o600);
    expect(ctx.steps[0]).toMatchObject({ kind: "open_url", opened: true });

    // 再次登录：用签发的 id、不带 agent_name_hint、host id 不变
    const again = await loginChatGpt({
      flavor: "siwc",
      method: "browser",
      env: ctx.env,
      dataDir: ctx.dataDir,
      port: 0,
      entry,
      deps: ctx.deps(),
    });
    expect(again.clientId).toBe("oaiapp_X1");
    const second = server?.requests.filter((r) => r.path === "/api/accounts/authorize")[1]?.query;
    expect(second?.get("client_id")).toBe("oaiapp_X1");
    expect(second?.has("agent_name_hint")).toBe(false);
    expect(second?.get("ext_agent_host_id")).toBe(hostId);
  });

  it("--paste：粘回调 URL 完成", async () => {
    const ctx = await setup();
    const entry = await loginChatGpt({
      flavor: "siwc",
      method: "paste",
      env: ctx.env,
      dataDir: ctx.dataDir,
      deps: ctx.deps(),
    });
    expect(entry.clientId).toBe("oaiapp_issued");
    expect(ctx.steps[0]?.kind).toBe("paste_prompt");
  });

  it("验签失败 / nonce 不符 / exp 过期 / scope 缺失各自报错", async () => {
    const cases: [FakeOAuthOptions, string, string?][] = [
      [{ wrongKey: true }, "oauth_invalid_token", "bad signature"],
      [{ idTokenClaims: (c) => ({ ...c, nonce: "other" }) }, "oauth_invalid_token", "nonce"],
      [{ idTokenClaims: (c) => ({ ...c, exp: 1000 }) }, "oauth_invalid_token", "exp"],
      [{ idTokenClaims: (c) => ({ ...c, aud: "someone-else" }) }, "oauth_invalid_token", "aud"],
      [{ scope: "openid profile email offline_access" }, "oauth_scope_missing"],
    ];
    for (const [options, code, reason] of cases) {
      const ctx = await setup(options);
      const error = await loginChatGpt({
        flavor: "siwc",
        method: "browser",
        env: ctx.env,
        dataDir: ctx.dataDir,
        port: 0,
        deps: ctx.deps(),
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code });
      if (reason !== undefined) expect((error as Error).message).toContain(reason);
      await server?.stop();
      server = undefined;
    }
  });

  it("SIWC 不支持设备码", async () => {
    const ctx = await setup();
    await expect(
      loginChatGpt({
        flavor: "siwc",
        method: "device",
        env: ctx.env,
        dataDir: ctx.dataDir,
        deps: ctx.deps(),
      }),
    ).rejects.toMatchObject({ code: "oauth_device_unsupported" });
  });

  it("登出撤销 refresh token（表单：token / token_type_hint / client_id）", async () => {
    const ctx = await setup();
    const entry = await loginChatGpt({
      flavor: "siwc",
      method: "paste",
      env: ctx.env,
      dataDir: ctx.dataDir,
      deps: ctx.deps(),
    });
    expect(await revokeChatGpt(fetch, entry, { env: ctx.env })).toBe(true);
    expect(server?.revoked).toEqual([entry.refreshToken]);
    const revoke = server?.requests.find((r) => r.path === "/revoke");
    const form = new URLSearchParams(revoke?.body);
    expect(form.get("token_type_hint")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("oaiapp_issued");
  });
});

describe("codex flavor（备用）", () => {
  it("浏览器登录：公开客户端、附加参数、只解码 id_token 取账户", async () => {
    const ctx = await setup();
    const entry = await loginChatGpt({
      flavor: "codex",
      method: "browser",
      env: ctx.env,
      dataDir: ctx.dataDir,
      port: 0,
      acknowledgedAt: "2026-10-03T00:00:00.000Z",
      deps: ctx.deps(),
    });
    expect(entry).toMatchObject({
      flavor: "codex",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      accountId: "acct-1",
      planType: "plus",
      acknowledgedAt: "2026-10-03T00:00:00.000Z",
    });
    const q = server?.requests.find((r) => r.path === "/oauth/authorize")?.query;
    expect(q?.get("id_token_add_organizations")).toBe("true");
    expect(q?.get("codex_cli_simplified_flow")).toBe("true");
    expect(q?.get("originator")).toBe("codex_cli_rs");
    expect(q?.has("nonce")).toBe(false);
    expect(q?.has("ext_agent_host_id")).toBe(false);
    expect(q?.get("scope")).toBe("openid profile email offline_access");
  });

  it("设备码：先 pending 再成功", async () => {
    const ctx = await setup({ devicePending: 2 });
    const entry = await loginChatGpt({
      flavor: "codex",
      method: "device",
      env: ctx.env,
      dataDir: ctx.dataDir,
      deps: ctx.deps(),
    });
    expect(entry.accountId).toBe("acct-1");
    expect(ctx.steps[0]).toMatchObject({ kind: "device_code", userCode: "ABCD-1234" });
    expect((ctx.steps[0] as { url: string }).url).toMatch(/\/codex\/device$/);
    expect(server?.requests.filter((r) => r.path.endsWith("/deviceauth/token"))).toHaveLength(3);
  });

  it("登出不撤销（只删本地）", async () => {
    const preset = resolveChatGptPreset("codex");
    expect(preset.revoke).toBe(false);
    expect(
      await revokeChatGpt(fetch, {
        type: "oauth",
        flavor: "codex",
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 0,
      }),
    ).toBe(false);
  });
});

describe("预设表", () => {
  it("覆盖优先级：env > 配置 > 条目签发 id > 缺省", () => {
    expect(resolveChatGptPreset("siwc").clientId).toBe("dynamic_agent_client");
    const entry = {
      type: "oauth" as const,
      flavor: "siwc" as const,
      clientId: "oaiapp_E",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 0,
    };
    expect(resolveChatGptPreset("siwc", { entry, env: {} }).clientId).toBe("oaiapp_E");
    expect(
      resolveChatGptPreset("siwc", { entry, env: {}, config: { clientId: "c" } }).clientId,
    ).toBe("c");
    expect(
      resolveChatGptPreset("siwc", { entry, env: { AMA_CHATGPT_CLIENT_ID: "e" } }).clientId,
    ).toBe("e");
    expect(resolveChatGptPreset("codex", { entry, env: {} }).clientId).toBe(
      "app_EMoamEEZ73f0CkXaXp7hrann",
    );
    expect(resolveChatGptPreset("siwc", { env: {} }).redirectPorts).toEqual([1455, 0]);
    expect(resolveChatGptPreset("codex", { env: {} }).redirectPorts).toEqual([1455, 1457]);
    expect(resolveChatGptPreset("codex", { env: {}, port: 9 }).redirectPorts).toEqual([9]);
    expect(
      resolveChatGptPreset("codex", { env: {}, config: { redirectPorts: [7, 8] } }).redirectPorts,
    ).toEqual([7, 8]);
    expect(
      resolveChatGptPreset("codex", { env: { AMA_CHATGPT_BASE_URL: "http://x/" } }).baseUrl,
    ).toBe("http://x/");
    expect(resolveChatGptPreset("siwc", { env: {} }).baseUrl).toBe("https://api.openai.com/v1");
    expect(
      resolveChatGptPreset("codex", { env: {}, config: { originator: "ama" } }).originator,
    ).toBe("ama");
  });

  it("授权 URL 端点", () => {
    const url = new URL(
      authorizeUrl(resolveChatGptPreset("siwc", { env: {} }), {
        redirectUri: "http://127.0.0.1:1/auth/callback",
        state: "s",
        challenge: "c",
        nonce: "n",
        hostId: "urn:uuid:x",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
  });
});
