/**
 * codex 方式的模型发现：`client_version` 用 Codex CLI 版本号（可配），fake codex 后端按它过滤；0 个时提示
 * codexClientVersion 过旧并写空缓存；后端元数据进缓存与注册表；缓存 flavor 与当前登录不符视为过期。
 * 全程走 fake OAuth / 后端与临时目录，不碰任何真实账户。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDiscoveredCache, writeDiscoveredCache } from "../../ai/providers/discovered-cache.js";
import { buildProviderRegistry } from "../../cli/compose-providers.js";
import type { CliIo } from "../../cli/deps.js";
import { runAuth } from "../../cli/subcommands/auth.js";
import { runModels } from "../../cli/subcommands/models.js";
import { modelItems } from "../../modes/interactive/model-items.js";
import { FakeOAuthServer, followAuthorize } from "../testing/fake-oauth.js";
import { DEFAULT_CODEX_CLIENT_VERSION } from "./presets.js";

let server: FakeOAuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const CATALOG = [
  {
    slug: "gpt-6-sol",
    display_name: "GPT-6 Sol",
    visibility: "list",
    minimal_client_version: "0.98.0",
    context_window: 272_000,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
  },
  {
    slug: "zz-codex-preview",
    visibility: "list",
    minimal_client_version: "0.144.0",
    context_window: 123_456,
    input_modalities: ["text"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }],
  },
  { slug: "codex-auto-review", visibility: "hide", minimal_client_version: "0.98.0" },
  { slug: "gpt-future", visibility: "list", minimal_client_version: "9.0.0" },
];

async function harness(env: Record<string, string> = {}) {
  server = new FakeOAuthServer({ marker: "SECRETMARK", codexModels: CATALOG });
  const issuer = await server.start();
  const root = mkdtempSync(join(tmpdir(), "ama-codex-models-"));
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
      AMA_CHATGPT_BASE_URL: `${issuer}/codex`,
      AMA_NO_LOCAL_PROBE: "1",
      ...env,
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
  const login = () =>
    runAuth(["login", "chatgpt", "--flavor", "codex", "--yes", "--port", "0"], io, deps);
  const versions = () =>
    server!.requests
      .filter((r) => r.path === "/codex/models")
      .map((r) => r.query.get("client_version"));
  return { io, out, err, dataDir, authFile, root, registry, login, versions };
}

describe("codex 方式的模型发现", () => {
  it("缺省 client_version 是 Codex CLI 版本：过滤掉 hide 与版本不够的；元数据写进缓存并补进注册表", async () => {
    const h = await harness();
    expect(await h.login()).toBe(0);
    expect(h.versions()).toEqual([DEFAULT_CODEX_CLIENT_VERSION]);
    expect(h.out.join("")).toContain("账户可用 2 个模型");
    const cache = readDiscoveredCache(h.dataDir, "chatgpt");
    expect(cache?.flavor).toBe("codex");
    expect(cache?.models).toEqual([
      {
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
        contextWindow: 272_000,
        input: ["text", "image"],
        reasoningLevels: ["low", "medium", "high"],
      },
      {
        id: "zz-codex-preview",
        contextWindow: 123_456,
        input: ["text"],
        reasoningLevels: ["low", "high", "xhigh"],
      },
    ]);
    const registry = await h.registry();
    const models = registry.get("chatgpt")?.models ?? [];
    expect(models.map((m) => m.id)).toEqual(["gpt-6-sol", "zz-codex-preview"]);
    // models.dev 补不到的 slug 用后端给的元数据
    const preview = models.find((m) => m.id === "zz-codex-preview");
    expect(preview).toMatchObject({
      contextWindow: 123_456,
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: "xhigh",
      },
      channels: ["codex"],
    });
  });

  it("client_version 过旧（环境变量 0.6.1）：0 个模型，提示 codexClientVersion，写空缓存并清掉旧 flavor 的缓存", async () => {
    const h = await harness({ AMA_CHATGPT_CODEX_CLIENT_VERSION: "0.6.1" });
    writeDiscoveredCache(h.dataDir, "chatgpt", {
      models: [{ id: "gpt-6-astra" }],
      flavor: "siwc",
    });
    expect(await h.login()).toBe(0);
    expect(h.versions()).toEqual(["0.6.1"]);
    expect(h.out.join("")).toContain("codexClientVersion（0.6.1）过旧");
    expect(h.out.join("")).toContain("ama config set auth.chatgpt.codexClientVersion");
    const cache = readDiscoveredCache(h.dataDir, "chatgpt");
    expect(cache).toMatchObject({ flavor: "codex", models: [] });
    const registry = await h.registry();
    expect(registry.get("chatgpt")?.models).toEqual([]);
    const items = await modelItems(registry, { view: "all" });
    expect(items.find((i) => i.value === "ama:hint:chatgpt")?.label).toBe(
      "运行 ama models discover chatgpt 获取模型",
    );
  });

  it("用户级 auth.chatgpt.codexClientVersion 生效（models discover 也用它）；0 个时同样提示", async () => {
    const h = await harness();
    mkdirSync(join(h.root, "config"), { recursive: true });
    writeFileSync(
      join(h.root, "config", "config.json"),
      JSON.stringify({ version: 1, auth: { chatgpt: { codexClientVersion: "0.99.0" } } }),
    );
    expect(await h.login()).toBe(0);
    expect(h.out.join("")).toContain("账户可用 1 个模型");
    const deps = { providers: { create: () => h.registry() } };
    expect(await runModels(["discover", "chatgpt"], h.io, deps)).toBe(0);
    expect(h.versions()).toEqual(["0.99.0", "0.99.0"]);
    expect(readDiscoveredCache(h.dataDir, "chatgpt")?.models).toEqual([
      {
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
        contextWindow: 272_000,
        input: ["text", "image"],
        reasoningLevels: ["low", "medium", "high"],
      },
    ]);

    writeFileSync(
      join(h.root, "config", "config.json"),
      JSON.stringify({ version: 1, auth: { chatgpt: { codexClientVersion: "0.1.0" } } }),
    );
    h.err.length = 0;
    expect(await runModels(["discover", "chatgpt"], h.io, deps)).toBe(0);
    expect(h.err.join("")).toContain("codexClientVersion（0.1.0）过旧");
    expect(readDiscoveredCache(h.dataDir, "chatgpt")).toMatchObject({
      flavor: "codex",
      models: [],
    });
  });

  it("缓存 flavor 与当前登录不符视为过期：不并入，选择器提示重新发现", async () => {
    const h = await harness();
    expect(await h.login()).toBe(0);
    writeDiscoveredCache(h.dataDir, "chatgpt", {
      models: [{ id: "gpt-6-astra" }],
      flavor: "siwc",
    });
    const registry = await h.registry();
    expect(registry.get("chatgpt")?.models).toEqual([]);
    const items = await modelItems(registry, { view: "all" });
    expect(items.find((i) => i.value === "ama:hint:chatgpt")?.label).toBe(
      "运行 ama models discover chatgpt 获取模型",
    );
  });
});
