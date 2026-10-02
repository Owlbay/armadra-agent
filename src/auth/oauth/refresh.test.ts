import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import type { OAuthAuthEntry } from "../../config/types-w6.js";
import { FakeOAuthServer, type FakeOAuthOptions } from "../testing/fake-oauth.js";
import { freshOAuthEntry } from "./refresh.js";
import { lockPath, readOAuthEntry, withRefreshLock, writeOAuthEntry } from "./token-store.js";

let server: FakeOAuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function seeded(
  options: FakeOAuthOptions = {},
  overrides: Partial<OAuthAuthEntry> = {},
): Promise<{ authFile: string; entry: OAuthAuthEntry; env: Record<string, string> }> {
  server = new FakeOAuthServer(options);
  const issuer = await server.start();
  const dir = mkdtempSync(join(tmpdir(), "ama-rf-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ version: 1, providers: { openai: { apiKey: "k" } } }), {
    mode: 0o600,
  });
  const entry: OAuthAuthEntry = {
    type: "oauth",
    flavor: "siwc",
    clientId: "oaiapp_1",
    issuer,
    accessToken: "at-old",
    refreshToken: "rt-old",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
  server.seedRefreshToken(entry.refreshToken, entry.clientId ?? "");
  writeOAuthEntry(authFile, "chatgpt", entry);
  return { authFile, entry, env: { AMA_CHATGPT_ISSUER: issuer } };
}

describe("token 存储", () => {
  it("写条目保留其它供应商；0600；读不到 / 坏文件返回 undefined", async () => {
    const { authFile } = await seeded();
    const raw = JSON.parse(readFileSync(authFile, "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(raw.providers["openai"]).toEqual({ apiKey: "k" });
    if (process.platform !== "win32") expect(statSync(authFile).mode & 0o777).toBe(0o600);
    expect(readOAuthEntry(authFile, "openai")).toBeUndefined();
    expect(readOAuthEntry(join(tmpdir(), "nope-ama.json"), "chatgpt")).toBeUndefined();
    writeOAuthEntry(authFile, "chatgpt", undefined);
    expect(readOAuthEntry(authFile, "chatgpt")).toBeUndefined();
  });

  it("锁：同进程串行；陈旧锁（> 60 s 且 pid 已死）被清除；活锁等待超时", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ama-lock-"));
    const file = join(dir, "auth.json");
    const order: string[] = [];
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        withRefreshLock(file, async () => {
          order.push(`${name}+`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`${name}-`);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2)
      expect(order[i]?.slice(0, 1)).toBe(order[i + 1]?.slice(0, 1));
    expect(existsSync(lockPath(file))).toBe(false);

    writeFileSync(lockPath(file), JSON.stringify({ pid: 2 ** 22 + 12345, at: "x" }));
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lockPath(file), old, old);
    await expect(withRefreshLock(file, async () => "ok")).resolves.toBe("ok");

    writeFileSync(lockPath(file), JSON.stringify({ pid: process.pid, at: "x" }));
    utimesSync(lockPath(file), old, old);
    await expect(withRefreshLock(file, async () => "x", { waitMs: 100 })).rejects.toMatchObject({
      code: "auth_lock_timeout",
    });
  });
});

describe("刷新", () => {
  it("新鲜不刷新；临近过期刷新并轮换 refresh token、写回", async () => {
    const fresh = await seeded({}, { expiresAt: Date.now() + 3_600_000 });
    expect(
      (await freshOAuthEntry(fresh.authFile, "chatgpt", { env: fresh.env }))?.accessToken,
    ).toBe("at-old");
    expect(server?.refreshCalls).toBe(0);
    await server?.stop();

    const ctx = await seeded();
    const next = await freshOAuthEntry(ctx.authFile, "chatgpt", { env: ctx.env });
    expect(next?.accessToken).not.toBe("at-old");
    expect(next?.refreshToken).not.toBe("rt-old");
    expect(server?.refreshCalls).toBe(1);
    expect(readOAuthEntry(ctx.authFile, "chatgpt")).toEqual(next);
    const form = new URLSearchParams(
      server?.requests.find((r) => r.path === "/api/accounts/oauth/token")?.body,
    );
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(form.get("client_id")).toBe("oaiapp_1");
    expect(form.has("scope")).toBe(false);
  });

  it("codex flavor 刷新用 JSON 编码", async () => {
    const ctx = await seeded({}, { flavor: "codex", clientId: "app_EMoamEEZ73f0CkXaXp7hrann" });
    await freshOAuthEntry(ctx.authFile, "chatgpt", { env: ctx.env });
    const request = server?.requests.find((r) => r.path === "/oauth/token");
    expect(String(request?.headers["content-type"])).toContain("application/json");
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({ grant_type: "refresh_token" });
  });

  it("进程内并发只刷新一次", async () => {
    const ctx = await seeded({ refreshDelayMs: 50 });
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => freshOAuthEntry(ctx.authFile, "chatgpt", { env: ctx.env })),
    );
    expect(new Set(results.map((r) => r?.accessToken)).size).toBe(1);
    expect(server?.refreshCalls).toBe(1);
  });

  it("force（401 后）：同一个被拒 token 才刷新；别人已换掉就直接用", async () => {
    const ctx = await seeded({}, { expiresAt: Date.now() + 3_600_000 });
    const forced = await freshOAuthEntry(
      ctx.authFile,
      "chatgpt",
      { env: ctx.env },
      {
        force: true,
        staleToken: "at-old",
      },
    );
    expect(forced?.accessToken).not.toBe("at-old");
    expect(server?.refreshCalls).toBe(1);
    const again = await freshOAuthEntry(
      ctx.authFile,
      "chatgpt",
      { env: ctx.env },
      {
        force: true,
        staleToken: "at-old",
      },
    );
    expect(again?.accessToken).toBe(forced?.accessToken);
    expect(server?.refreshCalls).toBe(1);
  });

  it("永久失败：needsLogin 且保留 token，抛 auth_expired；之后不再请求", async () => {
    const ctx = await seeded({ refreshError: "refresh_token_reused" });
    await expect(freshOAuthEntry(ctx.authFile, "chatgpt", { env: ctx.env })).rejects.toMatchObject({
      code: "auth_expired",
    });
    const stored = readOAuthEntry(ctx.authFile, "chatgpt");
    expect(stored).toMatchObject({
      needsLogin: true,
      refreshToken: "rt-old",
      accessToken: "at-old",
    });
    await expect(freshOAuthEntry(ctx.authFile, "chatgpt", { env: ctx.env })).rejects.toMatchObject({
      code: "auth_expired",
    });
    expect(server?.refreshCalls).toBe(1);
  });

  it("暂时失败退避重试 2 次", async () => {
    const ctx = await seeded();
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls++;
      if (calls <= 2) return new Response("{}", { status: 503 });
      return fetch(input, init);
    };
    const sleeps: number[] = [];
    const next = await freshOAuthEntry(ctx.authFile, "chatgpt", {
      env: ctx.env,
      fetch: flaky,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(next?.accessToken).not.toBe("at-old");
    expect(sleeps).toEqual([500, 1500]);
    const ctx2 = await seeded();
    const down: typeof fetch = async () => new Response("{}", { status: 502 });
    await expect(
      freshOAuthEntry(ctx2.authFile, "chatgpt", {
        env: ctx2.env,
        fetch: down,
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: "oauth_http" });
    expect(readOAuthEntry(ctx2.authFile, "chatgpt")?.needsLogin).toBeUndefined();
  });

  it("5 个子进程同时刷新同一 auth.json：token 端点只调用 1 次，拿到同一个新 token", async () => {
    const ctx = await seeded({ refreshDelayMs: 200 });
    const out = join(mkdtempSync(join(tmpdir(), "ama-child-")), "child.mjs");
    buildSync({
      entryPoints: [join(import.meta.dirname, "../testing/refresh-child.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: out,
      logLevel: "silent",
    });
    const run = (): Promise<string> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [out, ctx.authFile, "chatgpt"], {
          env: { ...process.env, ...ctx.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (d: Buffer) => (text += d.toString()));
        child.on("exit", () => resolve(text.trim()));
      });
    const results = await Promise.all([run(), run(), run(), run(), run()]);
    expect(server?.refreshCalls).toBe(1);
    const stored = readOAuthEntry(ctx.authFile, "chatgpt");
    const hash = createHash("sha256")
      .update(stored?.accessToken ?? "")
      .digest("hex");
    expect(results).toEqual([hash, hash, hash, hash, hash]);
    expect(existsSync(lockPath(ctx.authFile))).toBe(false);
  }, 30_000);
});
