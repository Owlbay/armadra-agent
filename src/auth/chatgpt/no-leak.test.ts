/**
 * [W6-O] 日志红线：OAuth token 不进会话文件、会话事件（RPC 原样转发）与错误文案。fake 服务器签发的每个 token
 * 都带预置标记串，跑一次成功回合、一次 401 刷新回合、一次失效回合后整体 grep。
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionImpl } from "../../agent/session.js";
import type { SessionEvent } from "../../agent/types.js";
import { ProviderRegistry } from "../../ai/providers/registry.js";
import { SessionManager } from "../../session/manager.js";
import { readOAuthEntry, writeOAuthEntry } from "../oauth/token-store.js";
import { FakeOAuthServer } from "../testing/fake-oauth.js";

const MARK = "LEAKMARK7Q";
let server: FakeOAuthServer | undefined;
afterEach(async () => {
  await server?.stop();
});

describe("token 不进会话 / 事件 / 错误", () => {
  it("成功、401 刷新、失效三种回合后，会话文件与事件里都没有标记串", async () => {
    server = new FakeOAuthServer({ marker: MARK });
    const issuer = await server.start();
    const root = mkdtempSync(join(tmpdir(), "ama-leak-"));
    const authFile = join(root, "auth.json");
    writeFileSync(authFile, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
    writeOAuthEntry(authFile, "chatgpt", {
      type: "oauth",
      flavor: "codex",
      clientId: "app_x",
      issuer,
      accountId: "acct-1",
      accessToken: `at-${MARK}`,
      refreshToken: `rt-${MARK}`,
      idToken: `id-${MARK}`,
      expiresAt: Date.now() + 3_600_000,
    });
    server.seedRefreshToken(`rt-${MARK}`, "app_x");
    const env = { AMA_CHATGPT_ISSUER: issuer };
    const registry = new ProviderRegistry({
      includeFake: false,
      config: {
        version: 1,
        providers: {
          chatgpt: {
            defaultChannel: "codex",
            channels: { codex: { api: "openai-responses", baseUrl: `${issuer}/codex` } },
          },
        },
      },
      keys: { authFile, userAuthFile: null, env, oauth: { env } },
    });
    const found = registry.findModel("chatgpt/gpt-6-sol");
    if (!found.ok) throw new Error("no model");
    const manager = SessionManager.create(join(root, "sessions"), root);
    const session = new AgentSessionImpl({
      retry: { enabled: false },
      abortGraceMs: 50,
      model: found.model,
      sessionManager: manager,
      providers: registry,
    });
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("one");
    server.responses.push({ status: 401, body: {} });
    await session.prompt("two");
    const entry = readOAuthEntry(authFile, "chatgpt");
    if (entry) writeOAuthEntry(authFile, "chatgpt", { ...entry, needsLogin: true });
    await session.prompt("three");
    await session.dispose();
    expect(server.refreshCalls).toBe(1);
    const errors = events.filter((e) => e.type === "agent_end");
    expect(errors.length).toBe(3);
    const files = readdirSync(join(root, "sessions"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    const text = files.map((f) => readFileSync(join(root, "sessions", f), "utf8")).join("\n");
    expect(text).toContain("auth_expired");
    expect(text).not.toContain(MARK);
    expect(JSON.stringify(events)).not.toContain(MARK);
  });
});
