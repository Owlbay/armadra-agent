/**
 * ChatGPT 订阅后端的上下文窗口取后端值：后端给的 `context_window` 优先于 models.dev（API 版 1.1M），压缩阈值
 * 随之按后端窗口算；models.dev 只补后端没给的字段；旧缓存（不含窗口）照旧用 models.dev，两边都没有时保守缺省。
 * 全程走 fake OAuth / 后端与临时目录，不碰任何真实账户。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompactionController } from "../../agent/session-compaction.js";
import {
  discoveredModels,
  readDiscoveredCache,
  SUBSCRIPTION_FALLBACK_CONTEXT_WINDOW,
} from "../../ai/providers/discovered-cache.js";
import { loadModelsDevIndex } from "../../ai/providers/models-dev-cache.js";
import type { Model } from "../../ai/types.js";
import { buildProviderRegistry } from "../../cli/compose-providers.js";
import type { CliIo } from "../../cli/deps.js";
import { runAuth } from "../../cli/subcommands/auth.js";
import { runModels } from "../../cli/subcommands/models.js";
import { prunePolicy } from "../../compaction/prune-tier.js";
import { FakeOAuthServer, followAuthorize } from "../testing/fake-oauth.js";

let server: FakeOAuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** gpt-5.5 在 models.dev 里是 1.05M 上下文、128k 输出；后端说 272k。 */
const CATALOG = [
  {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    visibility: "list",
    minimal_client_version: "0.98.0",
    context_window: 272_000,
    max_context_window: 1_000_000,
    auto_compact_token_limit: 244_800,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
  },
  { slug: "gpt-5.4-mini", visibility: "list", minimal_client_version: "0.98.0" },
  { slug: "zz-no-metadata", visibility: "list", minimal_client_version: "0.98.0" },
];

async function harness() {
  server = new FakeOAuthServer({ marker: "SECRETMARK", codexModels: CATALOG });
  const issuer = await server.start();
  const root = mkdtempSync(join(tmpdir(), "ama-chatgpt-ctx-"));
  const out: string[] = [];
  const io: CliIo = {
    stdout: (t) => void out.push(t),
    stderr: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: {
      AMA_CONFIG_DIR: join(root, "config"),
      AMA_DATA_DIR: join(root, "data"),
      AMA_CHATGPT_ISSUER: issuer,
      AMA_CHATGPT_BASE_URL: `${issuer}/codex`,
      AMA_NO_LOCAL_PROBE: "1",
    },
    cwd: root,
    readStdin: async () => "",
  };
  const dataDir = join(root, "data");
  const authFile = join(root, "config", "auth.json");
  const registry = () =>
    buildProviderRegistry(
      { config: { version: 1 }, cwd: root, authFile, authEnv: true, dataDir },
      { env: io.env, includeFake: false, probeLocal: false },
    );
  const login = () =>
    runAuth(["login", "chatgpt", "--flavor", "codex", "--yes", "--port", "0"], io, {
      openBrowser: async (url: string) => {
        void followAuthorize(url);
        return true;
      },
    });
  return { io, out, dataDir, registry, login };
}

/** 只给压缩控制器看模型的最小会话核心。 */
function controllerFor(model: Model): CompactionController {
  return new CompactionController({ model: () => model } as never);
}

describe("ChatGPT 订阅后端的上下文窗口", () => {
  it("后端给 272000：模型上下文 272k、压缩阈值据此计算；models.dev 只补输出上限", async () => {
    const h = await harness();
    expect(await h.login()).toBe(0);
    const models = (await h.registry()).get("chatgpt")?.models ?? [];
    const sol = models.find((m) => m.id === "gpt-5.5");
    expect(sol).toMatchObject({
      contextWindow: 272_000,
      maxTokens: 65_536,
      input: ["text", "image"],
      reasoning: true,
    });
    expect(sol?.thinkingLevelMap).toMatchObject({ low: "low", medium: null, high: "high" });
    // 后端没给的：models.dev 有就用它，都没有用保守缺省（不让自动压缩关闭）
    expect(models.find((m) => m.id === "gpt-5.4-mini")?.contextWindow).toBe(400_000);
    expect(models.find((m) => m.id === "zz-no-metadata")?.contextWindow).toBe(
      SUBSCRIPTION_FALLBACK_CONTEXT_WINDOW,
    );

    const controller = controllerFor(sol!);
    expect(controller.breaker.autoEnabled).toBe(true);
    const budget = 272_000 - controller.settings.reserveTokens;
    expect(controller.prunePolicy()).toEqual(prunePolicy(budget));
  });

  it("models discover 显示后端窗口并标注来源，列出后端没给窗口的模型", async () => {
    const h = await harness();
    expect(await h.login()).toBe(0);
    h.out.length = 0;
    const deps = { providers: { create: () => h.registry() } };
    expect(await runModels(["discover", "chatgpt"], h.io, deps)).toBe(0);
    const text = h.out.join("");
    const line = text.split("\n").find((l) => l.trim().startsWith("gpt-5.5 "));
    expect(line).toContain("ctx 272k（后端） · out 66k");
    expect(line).not.toContain("1.1M");
    expect(text).toContain("后端没有给出 gpt-5.4-mini, zz-no-metadata 的上下文窗口");
    expect(readDiscoveredCache(h.dataDir, "chatgpt")?.models[0]).toMatchObject({
      id: "gpt-5.5",
      contextWindow: 272_000,
    });
  });
});

describe("发现缓存的元数据优先级", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ama-chatgpt-ctx-md-"));
  const index = loadModelsDevIndex(dataDir);
  const provider = {
    id: "chatgpt",
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    models: [],
    requiresApiKey: true,
  } as never;

  it("旧缓存（不含窗口）照旧用 models.dev；后端明确给的输入模态与推理强度不被 models.dev 覆盖", () => {
    const [old, explicit] = discoveredModels(
      {
        version: 1,
        provider: "chatgpt",
        fetchedAt: "",
        models: [
          { id: "gpt-5.5" },
          { id: "gpt-5.5", contextWindow: 200_000, input: ["text"], reasoningLevels: ["none"] },
        ],
      },
      provider,
      () => index,
    );
    expect(old).toMatchObject({ contextWindow: 1_050_000, reasoning: true });
    expect(explicit).toMatchObject({
      contextWindow: 200_000,
      maxTokens: 65_536,
      input: ["text"],
      reasoning: false,
    });
    expect(explicit?.thinkingLevelMap).toBeUndefined();
    expect(explicit?.inputLimit).toBeUndefined();
  });

  it("保守缺省只给订阅供应商；其它供应商仍不猜窗口", () => {
    const file = { version: 1, provider: "x", fetchedAt: "", models: [{ id: "zz-unknown" }] };
    const [sub] = discoveredModels(file, provider, () => index);
    expect(sub?.contextWindow).toBe(SUBSCRIPTION_FALLBACK_CONTEXT_WINDOW);
    const other = { ...(provider as object), id: "relay" } as never;
    const [plain] = discoveredModels(file, other, () => index);
    expect(plain?.contextWindow).toBeUndefined();
  });
});
