import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { writeModelsDevCache } from "../../ai/providers/models-dev-cache.js";
import { trimModelsDev } from "../../ai/providers/models-dev.js";
import { buildProviderRegistry } from "../compose-providers.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { defaultIo } from "../main.js";
import { runConfig } from "./config.js";
import { runModels } from "./models.js";

let home: TmpHome;
let out: string[];

beforeEach(() => {
  home = createTmpHome();
  out = [];
});
afterEach(() => home.cleanup());

function io(): CliIo {
  return {
    ...defaultIo(),
    stdout: (t: string) => void out.push(t),
    stderr: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { ...home.env },
    cwd: home.cwd,
  };
}

const deps: Pick<RuntimeDeps, "providers"> = {
  providers: {
    create: (input) =>
      buildProviderRegistry(input, { env: {}, includeFake: false, probeLocal: false }),
  },
};

function seed(): void {
  home.write("home/.config/ama/config.json", {
    version: 1,
    providers: {
      relay: {
        apiKey: "sk-test",
        channels: {
          chat: { api: "openai-completions", baseUrl: "https://relay.example/v1" },
          messages: { api: "anthropic-messages", baseUrl: "https://relay.example" },
        },
        models: [
          { id: "kimi-k2.5", channels: ["chat", "messages"], maxTokens: 4096 },
          { id: "mystery" },
        ],
      },
    },
  });
  writeModelsDevCache(home.dataDir, {
    version: 2,
    url: "https://models.dev/api.json",
    fetchedAt: new Date().toISOString(),
    providers: trimModelsDev({
      moonshotai: {
        models: {
          "kimi-k2.5": {
            reasoning: true,
            tool_call: true,
            modalities: { input: ["text", "image"] },
            limit: { context: 262144, output: 262144 },
          },
        },
      },
    }),
  });
}

describe("models list / config show：渠道与元数据来源", () => {
  it("models list 列出渠道、补全后的字段与来源；未匹配的标出来", async () => {
    seed();
    expect(await runModels(["list", "--provider", "relay"], io(), deps)).toBe(0);
    const text = out.join("");
    expect(text).toContain("  @chat  openai-completions  https://relay.example/v1\n");
    expect(text).toContain("  @messages  anthropic-messages  https://relay.example\n");
    expect(text).toContain(
      "  relay/kimi-k2.5  ctx 262k · out 4k · 思考 · 图片 · 渠道 chat,messages\n",
    );
    expect(text).toContain(
      "      来源 ctx models.dev · out config · 图片 models.dev · 思考 models.dev · 价格 缺省；models.dev 原厂 moonshotai/kimi-k2.5\n",
    );
    expect(text).toContain("  relay/mystery  ctx ? · out 8k · 渠道 chat\n");
    expect(text).toContain("models.dev 未匹配");
  });

  it("[ME-D] 中转模型按 id 继承目录：来源标「目录（按 id 匹配）」并列出目录条目（不发请求）", async () => {
    home.write("home/.config/ama/config.json", {
      version: 1,
      providers: {
        relay: {
          apiKey: "sk-test",
          api: "openai-completions",
          baseUrl: "https://relay.example/v1",
          models: [{ id: "deepseek-v4-flash" }, { id: "gemini-3.8-flash-low" }],
        },
      },
    });
    expect(await runModels(["list", "--provider", "relay"], io(), deps)).toBe(0);
    const text = out.join("");
    expect(text).toContain("  relay/deepseek-v4-flash  ctx 1M · out 66k · 思考 · 图片\n");
    expect(text).toMatch(
      /图片 目录（按 id 匹配） · 思考 目录（按 id 匹配） · 价格 models\.dev；目录 deepseek\/deepseek-flash；models\.dev 显式 deepseek\/deepseek-flash/,
    );
    expect(text).toContain("  relay/gemini-3.8-flash-low  ctx 1M · out 66k · 图片\n");
    expect(text).toContain("；目录 google/gemini-3.8-flash；");
  });

  it("config show --json 带渠道与来源", async () => {
    seed();
    expect(await runConfig(["show", "--json"], io(), deps as RuntimeDeps)).toBe(0);
    const json = JSON.parse(out.join("")) as {
      providers: { id: string; channels?: unknown[]; models: { id: string; sources?: string }[] }[];
    };
    const relay = json.providers.find((p) => p.id === "relay");
    expect(relay?.channels).toHaveLength(2);
    expect(relay?.models.find((m) => m.id === "kimi-k2.5")?.sources).toMatch(/ctx models\.dev/);
  });
});
