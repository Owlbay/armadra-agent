/**
 * ChatGPT 模型的发现缓存：登录后写缓存、`ama models discover chatgpt` 也写、注册表并入、logout 清除。
 * 全程走 fake OAuth 服务器与 fake 模型列表接口，不碰任何真实账户。
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoveredCachePath,
  readDiscoveredCache,
  writeDiscoveredCache,
} from "../../ai/providers/discovered-cache.js";
import { buildProviderRegistry } from "../../cli/compose-providers.js";
import type { CliIo } from "../../cli/deps.js";
import { runAuth } from "../../cli/subcommands/auth.js";
import { runModels } from "../../cli/subcommands/models.js";
import { modelItems } from "../../modes/interactive/model-items.js";
import { FakeOAuthServer, followAuthorize } from "../testing/fake-oauth.js";

let server: FakeOAuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const MODELS = {
  data: [
    { id: "gpt-5.5", display_name: "GPT-5.5" },
    { id: "gpt-5.4-mini" },
    { id: "hidden-one", visibility: "hide" },
  ],
};

async function harness() {
  server = new FakeOAuthServer({ marker: "SECRETMARK" });
  const issuer = await server.start();
  const root = mkdtempSync(join(tmpdir(), "ama-discovered-"));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: {
      AMA_CONFIG_DIR: join(root, "config"),
      AMA_DATA_DIR: join(root, "data"),
      AMA_CHATGPT_ISSUER: issuer,
      AMA_CHATGPT_BASE_URL: `${issuer}/v1`,
      AMA_NO_LOCAL_PROBE: "1",
    },
    cwd: root,
    readStdin: async () => "",
  };
  const deps = {
    openBrowser: async (url: string) => {
      void followAuthorize(url);
      return true;
    },
  };
  const dataDir = join(root, "data");
  const authFile = join(root, "config", "auth.json");
  const registry = () =>
    buildProviderRegistry(
      { config: { version: 1 }, cwd: root, authFile, authEnv: true, dataDir },
      { env: io.env, includeFake: false, probeLocal: false },
    );
  return { io, out, err, deps, dataDir, authFile, registry };
}

describe("ChatGPT 发现缓存", () => {
  it("登录成功后查模型列表写缓存；注册表并入，表外 slug 照样接受；选择器列出；logout 清除", async () => {
    const h = await harness();
    server!.responses.push({ status: 200, body: MODELS });
    expect(await runAuth(["login", "chatgpt", "--port", "0"], h.io, h.deps)).toBe(0);
    expect(h.out.join("")).toContain(
      "账户可用 2 个模型，用 /model 或 --model chatgpt/<模型> 选择。",
    );
    expect(h.out.join("")).toContain("能否把套餐额度共享给 ama，要到首次请求时才能确认");
    const listing = server!.requests.find((r) => r.path === "/v1/models");
    expect(listing?.method).toBe("GET");
    const cache = readDiscoveredCache(h.dataDir, "chatgpt");
    expect(cache).toMatchObject({
      provider: "chatgpt",
      flavor: "siwc",
      models: [{ id: "gpt-5.5", name: "GPT-5.5" }, { id: "gpt-5.4-mini" }],
    });
    expect(cache?.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const raw = readFileSync(discoveredCachePath(h.dataDir, "chatgpt"), "utf8");
    expect(raw).not.toContain("SECRETMARK");
    expect(raw).not.toContain("acct-1");

    const registry = await h.registry();
    expect(registry.get("chatgpt")?.models.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
    expect(registry.modelSource("chatgpt", "gpt-5.5")).toBe("discovered");
    const other = registry.findModel("chatgpt/gpt-9-preview");
    expect(other.ok && other.model.id).toBe("gpt-9-preview");
    const items = await modelItems(registry);
    expect(items.filter((i) => i.value.startsWith("chatgpt/")).map((i) => i.group)).toEqual([
      "chatgpt · 已登录 ✓",
      "chatgpt · 已登录 ✓",
    ]);
    // 只挂登录 flavor（siwc）的渠道：说明里没有「另有 @codex」，@ 筛选也不出 @codex 行
    expect(registry.get("chatgpt")?.models[0]?.channels).toEqual(["siwc"]);
    expect(items.some((i) => i.description?.includes("@codex") === true)).toBe(false);
    const channelRows = await modelItems(registry, { channels: true });
    expect(channelRows.some((i) => i.value.includes("@"))).toBe(false);

    expect(await runAuth(["logout", "chatgpt"], h.io, h.deps)).toBe(0);
    expect(existsSync(discoveredCachePath(h.dataDir, "chatgpt"))).toBe(false);
    const after = await h.registry();
    expect(after.get("chatgpt")?.models).toEqual([]);
    const all = await modelItems(after, { view: "all" });
    expect(all.find((i) => i.value === "ama:hint:chatgpt")?.label).toBe(
      "运行 ama auth login chatgpt 登录",
    );
  });

  it("登录时模型列表失败：照常登录，退回 discover 提示，不写缓存；已登录无缓存时选择器给 discover 提示行", async () => {
    const h = await harness();
    server!.responses.push({ status: 500, body: {} });
    expect(await runAuth(["login", "chatgpt", "--port", "0"], h.io, h.deps)).toBe(0);
    expect(h.out.join("")).toContain("ama models discover chatgpt 查看");
    expect(readDiscoveredCache(h.dataDir, "chatgpt")).toBeUndefined();
    const items = await modelItems(await h.registry());
    expect(items.find((i) => i.value === "ama:hint:chatgpt")?.label).toBe(
      "运行 ama models discover chatgpt 获取模型",
    );

    // `ama models discover chatgpt` 写同一份缓存
    server!.responses.push({ status: 200, body: MODELS });
    const deps = { providers: { create: () => h.registry() } };
    expect(await runModels(["discover", "chatgpt"], h.io, deps)).toBe(0);
    expect(h.out.join("")).toContain("模型列表已缓存到");
    expect(readDiscoveredCache(h.dataDir, "chatgpt")?.models.map((m) => m.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
    const registry = await h.registry();
    expect(registry.get("chatgpt")?.models.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
  });

  it("codex 登录的缓存只挂 codex 渠道", async () => {
    const h = await harness();
    writeDiscoveredCache(h.dataDir, "chatgpt", { models: [{ id: "gpt-5.5" }], flavor: "codex" });
    const registry = await h.registry();
    expect(registry.get("chatgpt")?.models[0]?.channels).toEqual(["codex"]);
    const items = await modelItems(registry, { view: "all", channels: true });
    expect(items.filter((i) => i.value.startsWith("chatgpt/")).map((i) => i.value)).toEqual([
      "chatgpt/gpt-5.5",
    ]);
    expect(items.find((i) => i.value === "chatgpt/gpt-5.5")?.description ?? "").not.toContain("@");
  });

  it("缓存只并入模型表为空的供应商；损坏的缓存忽略", async () => {
    const h = await harness();
    writeDiscoveredCache(h.dataDir, "openai", { models: [{ id: "should-not-merge" }] });
    writeDiscoveredCache(h.dataDir, "chatgpt", { models: [{ id: "gpt-5.5" }], flavor: "siwc" });
    const registry = await h.registry();
    expect(registry.get("openai")?.models.some((m) => m.id === "should-not-merge")).toBe(false);
    expect(registry.get("chatgpt")?.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
    // models.dev 快照补元数据（上下文窗口不是自定义缺省的空值）
    expect(registry.get("chatgpt")?.models[0]?.contextWindow).toBeGreaterThan(0);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(discoveredCachePath(h.dataDir, "chatgpt"), "{not json");
    expect((await h.registry()).get("chatgpt")?.models).toEqual([]);
  });
});
