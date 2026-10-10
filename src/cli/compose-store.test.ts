import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { fakeProviderData } from "../ai/fake/fake-provider.js";
import { SessionManager } from "../session/manager.js";
import { sessionDirForCwd } from "../session/store.js";
import { DEFAULT_CONFIG } from "../config/merge.js";
import { buildProviderRegistry, probeLocalProviders } from "./compose-providers.js";
import { createRuntimeDeps } from "./compose.js";
import { createSessionStore, findSessionFile } from "./compose-store.js";

let home: TmpHome | undefined;
let server: Server | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  home?.cleanup();
  home = undefined;
  server?.close();
  server = undefined;
});

function saved(root: string, cwd: string, text: string): SessionManager {
  const manager = SessionManager.create(sessionDirForCwd(root, cwd), cwd);
  manager.append({
    type: "message",
    message: { role: "user", content: text, timestamp: 1 },
  });
  manager.flush();
  manager.close();
  return manager;
}

describe("会话存储", () => {
  it("new 延迟落盘；continue 取最近；resume 按前缀；session-id 不存在则新建；fork 复制到新文件", async () => {
    home = createTmpHome();
    const root = home.path("sessions");
    const store = createSessionStore();
    const ctx = { sessionDir: root, cwd: home.cwd };
    const fresh = await store.open({ kind: "new" }, ctx);
    expect(fresh.file()).toBeUndefined();
    const a = saved(root, home.cwd, "first");
    const resumed = await store.open({ kind: "resume", id: a.id.slice(0, 6) }, ctx);
    expect(resumed.id).toBe(a.id);
    (resumed as SessionManager).close();
    const cont = await store.open({ kind: "continue" }, ctx);
    expect(cont.id).toBe(a.id);
    (cont as SessionManager).close();
    const byId = await store.open({ kind: "session-id", id: "custom-id" }, ctx);
    expect(byId.id).toBe("custom-id");
    const forked = await store.open({ kind: "fork", id: a.id }, ctx);
    expect(forked.id).not.toBe(a.id);
    expect(forked.file()).toBeDefined();
    expect(forked.entries()).toHaveLength(1);
    expect(() => store.open({ kind: "resume", id: "zzz" }, ctx)).toThrow("会话不存在：zzz");
  });

  it("list 按 cwd / 全部；show 给条目；prune 移到 trash", async () => {
    home = createTmpHome();
    const root = home.path("sessions");
    const store = createSessionStore();
    const a = saved(root, home.cwd, "here");
    saved(root, home.path("other"), "there");
    expect((await store.list!({ sessionDir: root, cwd: home.cwd })).map((i) => i.id)).toEqual([
      a.id,
    ]);
    expect(await store.list!({ sessionDir: root })).toHaveLength(2);
    const shown = await store.show!(a.id.slice(0, 8), { sessionDir: root });
    expect(shown.item.firstPrompt).toBe("here");
    expect(shown.entries).toHaveLength(1);
    const dry = await store.prune!({ sessionDir: root, olderThanDays: 0, dryRun: true });
    expect(dry.moved).toHaveLength(2);
    const done = await store.prune!({
      sessionDir: root,
      cwd: home.cwd,
      olderThanDays: 0,
      dryRun: false,
    });
    expect(done.moved).toEqual([a.file()]);
    expect(findSessionFile(root, a.id)).toBeUndefined();
  });
});

describe("#183 --fork 的源会话：图片读不回的告警交给 log", () => {
  /** 含图消息被 context_edit 改写（打开时卸载）的会话。 */
  function withImage(root: string, cwd: string): SessionManager {
    const manager = SessionManager.create(sessionDirForCwd(root, cwd), cwd);
    const content = [
      { type: "text" as const, text: "x" },
      { type: "image" as const, mimeType: "image/png", data: "aW1n" },
    ];
    const id = manager.append({
      type: "message",
      message: { role: "user", content, timestamp: 1 },
    }).id;
    manager.append({
      type: "context_edit",
      targetId: id,
      replacement: "[image omitted]",
      reason: "image_budget",
    });
    manager.flush();
    manager.close();
    return manager;
  }

  /** 打开之后、fork 之前文件被外部改写。 */
  function rewriteAfterOpen(): void {
    const open = SessionManager.open.bind(SessionManager);
    vi.spyOn(SessionManager, "open").mockImplementation((file, options) => {
      const manager = open(file, options);
      writeFileSync(file, "{}\n".repeat(4), "utf8");
      return manager;
    });
  }

  it("createSessionStore(log)：fork 源会话回读失败 → log(warn) 恰好 1 次", async () => {
    home = createTmpHome();
    const root = home.path("sessions");
    const source = withImage(root, home.cwd);
    rewriteAfterOpen();
    const logged: [string, string][] = [];
    const store = createSessionStore((level, message) => logged.push([level, message]));
    const forked = await store.open(
      { kind: "fork", id: source.id },
      { sessionDir: root, cwd: home.cwd },
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toBe("warn");
    expect(logged[0]![1]).toMatch(/^cannot read session entry \S+ back from /);
    (forked as SessionManager).close();
  });

  it("装配：createRuntimeDeps 的 log 传到会话存储", async () => {
    home = createTmpHome();
    const root = home.path("sessions");
    const source = withImage(root, home.cwd);
    rewriteAfterOpen();
    const logged: string[] = [];
    const deps = createRuntimeDeps({
      env: home.env,
      probeLocal: false,
      log: (_l, m) => logged.push(m),
    });
    const forked = await deps.sessions.open(
      { kind: "fork", id: source.id },
      { sessionDir: root, cwd: home.cwd },
    );
    expect(logged).toHaveLength(1);
    (forked as SessionManager).close();
  });
});

describe("供应商注册表", () => {
  const base = { cwd: "/w", authFile: "/nonexistent/auth.json", authEnv: true };

  it("--api-key 只给 --model 所属供应商（无斜杠模型名先解析供应商）", async () => {
    const model = (
      await buildProviderRegistry({ ...base, config: { version: 1 } }, { env: {} })
    ).get("deepseek")?.models[0]?.id as string;
    const registry = await buildProviderRegistry(
      { ...base, config: { version: 1 }, cliApiKey: { apiKey: "sk-x", modelRef: model } },
      { env: {}, probeLocal: false },
    );
    expect((await registry.resolveApiKey("deepseek")).source).toBe("cli");
    expect((await registry.resolveApiKey("anthropic")).apiKey).toBeUndefined();
  });

  it("SDK 追加的供应商折进 config.providers", async () => {
    const extra = { ...fakeProviderData(), id: "mine", name: "Mine" };
    const registry = await buildProviderRegistry(
      { ...base, config: { ...DEFAULT_CONFIG } },
      { env: {}, providers: [extra], probeLocal: false },
    );
    expect(registry.findModel("mine/echo").ok).toBe(true);
  });

  it("本地探测：无 key 时把本地服务的模型加进注册表", async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const registry = await buildProviderRegistry(
      {
        ...base,
        config: { version: 1, providers: { lmstudio: { baseUrl: `http://127.0.0.1:${port}/v1` } } },
      },
      { env: {}, probeLocal: false },
    );
    expect(registry.get("lmstudio")?.models).toHaveLength(0);
    expect(await probeLocalProviders(registry, 2000)).toContain("lmstudio");
    expect(registry.findModel("lmstudio/local-model").ok).toBe(true);
  });
});
