import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { ApiRegistry } from "../../ai/apis/api.js";
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
    expect(text).toContain("  grok-4.7\n");
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
    expect(text).not.toContain("qwen-x  ");
    expect(calls.map((c) => `${c.id}:${c.api}`)).toEqual([
      "deepseek-v4-flash:openai-completions",
      "glm-5:openai-completions",
      "grok-4.7:openai-completions",
      "grok-4.7:openai-responses",
      "MiniMax-M2.7:openai-completions",
      "MiniMax-M2.7:openai-responses",
      "MiniMax-M2.7:anthropic-messages",
    ]);
    expect(calls.every((c) => c.apiKey === "sk-relay" && c.baseUrl === RELAY.baseUrl)).toBe(true);
  });

  it("--probe：三种都失败记不可用；401 / 429 立即停止 → 1；--limit 非正整数 → 用法错误", async () => {
    writeConfig({ relay: RELAY });
    stubFetch(["unknown-a", "grok-4.7"]);
    expect(await runModels(["discover", "relay", "--probe"], io(), deps())).toBe(0);
    expect(out.join("")).toContain("  unknown-a  不可用（三种协议均失败）");
    calls = [];
    failWith = "429 rate limited";
    expect(await runModels(["discover", "relay", "--probe"], io(), deps())).toBe(1);
    expect(calls).toHaveLength(1);
    expect(err.join("")).toContain("探测提前停止（429 rate limited）");
    await expect(
      runModels(["discover", "relay", "--probe", "--limit", "0"], io(), deps()),
    ).rejects.toThrow(/--limit 需要正整数/);
  });
});
