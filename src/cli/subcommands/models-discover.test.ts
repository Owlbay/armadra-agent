import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { ApiRegistry } from "../../ai/apis/api.js";
import { writeModelsDevCache } from "../../ai/providers/models-dev-cache.js";
import { trimModelsDev } from "../../ai/providers/models-dev.js";
import type { Api, ApiImplementation, Model } from "../../ai/types.js";
import { buildProviderRegistry } from "../compose-providers.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { defaultIo } from "../main.js";
import { discoverModels, modelsUrl, probeOrder } from "./models-discover.js";
import { runModels } from "./models.js";

let home: TmpHome;
let out: string[];
let err: string[];
let requests: { url: string; headers: Record<string, string>; body?: unknown }[];

beforeEach(() => {
  home = createTmpHome();
  calls = [];
  failWith = undefined;
  out = [];
  err = [];
  requests = [];
});
afterEach(() => {
  home.cleanup();
  vi.unstubAllGlobals();
});

const RELAY = {
  baseUrl: "https://relay.example/v1",
  apiKey: "$RELAY_KEY",
  models: [{ id: "glm-5", api: "anthropic-messages" }],
};

function io(): CliIo {
  return {
    ...defaultIo(),
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { ...home.env, RELAY_KEY: "sk-relay" },
    cwd: home.cwd,
  };
}

/** 实测中转的协议支持（同一 baseUrl 下各模型不同）。 */
const SUPPORT: Record<string, Api[]> = {
  "deepseek-v4-flash": ["openai-completions", "openai-responses", "anthropic-messages"],
  "glm-5": ["openai-completions", "anthropic-messages"],
  "grok-4.7": ["openai-responses"],
  "MiniMax-M2.7": ["anthropic-messages"],
};
let calls: { id: string; api: Api; apiKey: string | undefined; baseUrl: string | undefined }[];
let failWith: string | undefined;

/** fake 协议实现：按 SUPPORT 决定成败，记录每次调用。 */
function fakeApis(): ApiRegistry {
  const apis = new ApiRegistry();
  for (const id of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    const impl: ApiImplementation = {
      id,
      stream: (model: Model, _context, options) => {
        calls.push({
          id: model.id,
          api: model.api,
          apiKey: options.apiKey,
          baseUrl: model.baseUrl,
        });
        const ok = failWith === undefined && (SUPPORT[model.id] ?? []).includes(model.api);
        const message = {
          role: "assistant" as const,
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: ok ? ("stop" as const) : ("error" as const),
          ...(ok ? {} : { errorMessage: failWith ?? "404 model not supported on this endpoint" }),
          timestamp: 0,
        };
        return {
          result: async () => message,
          [Symbol.asyncIterator]: async function* () {},
        } as never;
      },
    };
    apis.register(impl);
  }
  return apis;
}

function deps(): Pick<RuntimeDeps, "providers"> {
  return {
    providers: {
      create: (input) =>
        buildProviderRegistry(input, {
          env: { RELAY_KEY: "sk-relay" },
          apis: fakeApis(),
          includeFake: false,
          probeLocal: false,
        }),
    },
  };
}

function writeConfig(providers: Record<string, unknown>): string {
  return home.write("home/.config/ama/config.json", { version: 1, providers });
}

/** fake 中转：`/models` 列表；其余路径交给 `chat`。 */
function stubFetch(ids: string[], chat?: (url: string, body: unknown) => Response): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ url, headers, body });
    if (url.endsWith("/models")) return Response.json({ data: ids.map((id) => ({ id })) });
    if (chat !== undefined) return chat(url, body);
    return new Response("not found", { status: 404 });
  });
}

describe("ama models discover", () => {
  it("modelsUrl：OpenAI 系 {baseUrl}/models；Anthropic 不带 /v1 的 baseUrl 补 /v1", () => {
    const base = {
      id: "p",
      name: "p",
      envKeys: [],
      models: [],
      requiresApiKey: true,
      builtin: false,
    };
    expect(
      modelsUrl({ ...base, api: "openai-completions", baseUrl: "https://r.example/v1/" }),
    ).toBe("https://r.example/v1/models");
    expect(
      modelsUrl({ ...base, api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }),
    ).toBe("https://api.anthropic.com/v1/models");
    expect(modelsUrl({ ...base, api: "anthropic-messages", baseUrl: "https://r.example/v1" })).toBe(
      "https://r.example/v1/models",
    );
  });

  it("discoverModels 带鉴权头、去重；非 2xx 抛错", async () => {
    stubFetch(["a", "b", "a"]);
    const provider = {
      id: "relay",
      name: "relay",
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
      envKeys: [],
      models: [],
      requiresApiKey: true,
      builtin: false,
    };
    const models = await discoverModels(provider, "sk-x");
    expect(models.map((m) => [m.id, m.api])).toEqual([
      ["a", "openai-completions"],
      ["b", "openai-completions"],
    ]);
    expect(requests[0]?.headers["authorization"]).toBe("Bearer sk-x");
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    await expect(discoverModels(provider, "sk-x")).rejects.toThrow(/401/);
  });

  it("列出 id 并标出已配置的条目；供应商不存在 → 4；列表失败 → 1，不输出 key", async () => {
    writeConfig({ relay: RELAY });
    stubFetch(["deepseek-v4-flash", "glm-5", "grok-4.7"]);
    expect(await runModels(["discover", "relay"], io(), deps())).toBe(0);
    const text = out.join("");
    expect(text).toContain("relay：发现 3 个模型（https://relay.example/v1/models）");
    expect(text).toContain("  glm-5  已配置（anthropic-messages）");
    // 快照随包携带，不联网也能匹配
    expect(text).toMatch(/ {2}grok-4\.7 {2}ctx .* · \S+ xai\/grok-4\.7\n/);
    expect(requests.every((r) => !r.url.includes("models.dev"))).toBe(true);
    expect(await runModels(["discover", "nope"], io(), deps())).toBe(4);
    expect(await runModels(["discover"], io(), deps()).catch((e: Error) => e.message)).toMatch(
      /需要 <provider>/,
    );
    vi.stubGlobal("fetch", async () => new Response("bad key", { status: 401 }));
    expect(await runModels(["discover", "relay"], io(), deps())).toBe(1);
    expect(err.join("")).toContain("模型列表获取失败");
    expect([...out, ...err].join("")).not.toContain("sk-relay");
  });

  it("--probe：供应商协议排最前，每模型取第一个成功的协议，最多 3 次请求；--limit 限模型数", async () => {
    writeConfig({ relay: RELAY });
    stubFetch(Object.keys(SUPPORT).concat("qwen-x"));
    expect(probeOrder({ api: "anthropic-messages" } as Parameters<typeof probeOrder>[0])).toEqual([
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
    ]);
    expect(await runModels(["discover", "relay", "--probe", "--limit", "4"], io(), deps())).toBe(0);
    const text = out.join("");
    expect(text).toContain(
      "探测协议：4 个模型（openai-completions → openai-responses → anthropic-messages），最多 12 次请求；另有 1 个超出 --limit 4，未探测",
    );
    expect(text).toContain("  deepseek-v4-flash  openai-completions\n");
    expect(text).toContain("  glm-5  openai-completions\n");
    expect(text).toContain("  grok-4.7  openai-responses\n");
    expect(text).toContain("  MiniMax-M2.7  anthropic-messages\n");
    expect(text).not.toContain("qwen-x  openai");
    // 模型之间并发：同一模型内按协议顺序，模型之间的先后不固定
    const tried = (id: string): Api[] => calls.filter((c) => c.id === id).map((c) => c.api);
    expect(calls).toHaveLength(7);
    expect(tried("deepseek-v4-flash")).toEqual(["openai-completions"]);
    expect(tried("glm-5")).toEqual(["openai-completions"]);
    expect(tried("grok-4.7")).toEqual(["openai-completions", "openai-responses"]);
    expect(tried("MiniMax-M2.7")).toEqual([
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
    ]);
    // 输出按模型顺序，不按完成顺序
    expect(text.indexOf("  glm-5  ")).toBeLessThan(text.indexOf("  grok-4.7  "));
    expect(text.indexOf("  grok-4.7  ")).toBeLessThan(text.indexOf("  MiniMax-M2.7  "));
    expect(calls.every((c) => c.apiKey === "sk-relay" && c.baseUrl === RELAY.baseUrl)).toBe(true);
  });

  it("--probe：三种都失败记不可用；401 立即停止 → 1；--limit / --concurrency 越界 → 用法错误", async () => {
    writeConfig({ relay: RELAY });
    stubFetch(["unknown-a", "grok-4.7"]);
    expect(await runModels(["discover", "relay", "--probe"], io(), deps())).toBe(0);
    expect(out.join("")).toContain("  unknown-a  不可用（三种协议均失败）");
    calls = [];
    failWith = "401 invalid key";
    expect(
      await runModels(["discover", "relay", "--probe", "--concurrency", "1"], io(), deps()),
    ).toBe(1);
    expect(calls).toHaveLength(1);
    expect(err.join("")).toContain("探测提前停止（401 invalid key）");
    await expect(
      runModels(["discover", "relay", "--probe", "--limit", "0"], io(), deps()),
    ).rejects.toThrow(/--limit 需要正整数/);
    await expect(
      runModels(["discover", "relay", "--probe", "--concurrency", "17"], io(), deps()),
    ).rejects.toThrow(/--concurrency 需要 1–16 的整数/);
  });

  it("--probe --write：只写探测成功的新模型（id + 与供应商不同的 api），已有同 id 不覆盖，先备份", async () => {
    const path = writeConfig({ relay: RELAY });
    stubFetch(["deepseek-v4-flash", "glm-5", "grok-4.7", "unknown-a"]);
    expect(await runModels(["discover", "relay", "--probe", "--write"], io(), deps())).toBe(0);
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      providers: { relay: { models: unknown[]; apiKey: string } };
    };
    expect(written.providers.relay.models).toEqual([
      { id: "glm-5", api: "anthropic-messages" },
      { id: "deepseek-v4-flash" },
      { id: "grok-4.7", api: "openai-responses" },
    ]);
    expect(written.providers.relay.apiKey).toBe("$RELAY_KEY");
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8"))).toEqual({
      version: 1,
      providers: { relay: RELAY },
    });
    expect(out.join("")).toContain("relay 新增 2 个模型，1 个已存在未覆盖");
    // 写入的三个都在快照里匹配得到，不警告
    expect(err.join("")).not.toContain("未匹配");
    out = [];
    expect(await runModels(["discover", "relay", "--write"], io(), deps())).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).providers.relay.models).toContainEqual({
      id: "unknown-a",
    });
    expect(out.join("")).toContain("relay 新增 1 个模型，3 个已存在未覆盖");
    expect(err.join("")).toContain(
      "unknown-a 在 models.dev 未匹配，没有 contextWindow，自动压缩关闭",
    );
  });

  it("--write：供应商不在用户级配置且非内置 → 不写", async () => {
    stubFetch(["a"]);
    const profileDeps: Pick<RuntimeDeps, "providers"> = {
      providers: {
        create: (input) =>
          buildProviderRegistry(
            { ...input, config: { version: 1, providers: { relay: RELAY } } },
            { env: { RELAY_KEY: "sk-relay" }, includeFake: false, probeLocal: false },
          ),
      },
    };
    expect(await runModels(["discover", "relay", "--write"], io(), profileDeps)).toBe(0);
    expect(err.join("")).toContain("relay 不在用户级配置");
  });

  it("models.dev：列表标出元数据与匹配；--write 跳过不支持工具调用的模型", async () => {
    writeConfig({ relay: { ...RELAY, models: [] } });
    const md = {
      moonshotai: {
        models: {
          "kimi-k2.5": {
            tool_call: true,
            modalities: { input: ["text", "image"] },
            limit: { context: 262144, output: 32768 },
          },
          "embed-x": { tool_call: false, limit: { context: 8192 } },
        },
      },
    };
    // `ama models refresh` 写下的用户级覆盖（晚于内置快照才叠加）
    writeModelsDevCache(home.dataDir, {
      version: 2,
      url: "https://models.dev/api.json",
      fetchedAt: "2999-01-01T00:00:00.000Z",
      providers: trimModelsDev(md),
    });
    vi.stubGlobal("fetch", async () =>
      Response.json({ data: [{ id: "kimi-k2.5" }, { id: "embed-x" }, { id: "odd" }] }),
    );
    expect(await runModels(["discover", "relay", "--write"], io(), deps())).toBe(0);
    const text = out.join("");
    expect(text).toContain("⊕ 刷新 2999-01-01");
    expect(text).toContain("  kimi-k2.5  ctx 262k · out 33k · 图片 · 原厂 moonshotai/kimi-k2.5\n");
    expect(text).toContain(
      "  embed-x  ctx 8k · out ? · 不支持工具调用 · 原厂 moonshotai/embed-x\n",
    );
    expect(text).toContain("跳过不支持工具调用的模型（models.dev）：embed-x");
    const written = JSON.parse(home.read("home/.config/ama/config.json")) as {
      providers: { relay: { models: { id: string }[] } };
    };
    expect(written.providers.relay.models.map((m) => m.id)).toEqual(["kimi-k2.5", "odd"]);
    expect(err.join("")).toContain("odd 在 models.dev 未匹配");
  });
});
