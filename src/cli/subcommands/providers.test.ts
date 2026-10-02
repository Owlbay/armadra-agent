import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { ApiRegistry } from "../../ai/apis/api.js";
import type { Api, ApiImplementation, Model } from "../../ai/types.js";
import type { AmaConfig } from "../../config/types.js";
import { buildProviderRegistry } from "../compose-providers.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { defaultIo } from "../main.js";
import { runProviders } from "./providers.js";

let home: TmpHome;
let out: string[];
let err: string[];
let calls: { id: string; api: Api; baseUrl: string | undefined; apiKey: string | undefined }[];
let requests: { url: string; headers: Record<string, string> }[];

const MD_URL = "http://models-dev.test/api.json";
const SAMPLE = JSON.parse(
  readFileSync(join(process.cwd(), "test/fixtures/models-dev/api-sample.json"), "utf8"),
) as unknown;

/** 中转实测的协议支持（同一 baseUrl 下各模型不同）。 */
const SUPPORT: Record<string, Api[]> = {
  "deepseek-flash": ["openai-completions", "openai-responses", "anthropic-messages"],
  "kimi-k2.5": ["openai-completions", "anthropic-messages"],
  "grok-4.7": ["openai-responses"],
  "MiniMax-M2.7": ["openai-completions"],
};
const LISTING = [
  { id: "kimi-k2.5", supported_endpoint_types: ["openai", "openai-response", "anthropic"] },
  { id: "grok-4.7", supported_endpoint_types: ["openai-response"] },
  { id: "deepseek-flash" },
  { id: "MiniMax-M2.7", supported_endpoint_types: ["openai"] },
  { id: "qwen3-vl-flash", supported_endpoint_types: ["openai"] },
];

beforeEach(() => {
  home = createTmpHome();
  out = [];
  err = [];
  calls = [];
  requests = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url === MD_URL) return Response.json(SAMPLE, { headers: { etag: '"x"' } });
    if (url.endsWith("/models")) return Response.json({ data: LISTING });
    return new Response("not found", { status: 404 });
  });
});
afterEach(() => {
  home.cleanup();
  vi.unstubAllGlobals();
});

function io(stdin = ""): CliIo {
  return {
    ...defaultIo(),
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { ...home.env, AMA_MODELS_DEV_URL: MD_URL, RELAY_KEY: "sk-relay" },
    cwd: home.cwd,
    readStdin: async () => stdin,
  };
}

function fakeApis(): ApiRegistry {
  const apis = new ApiRegistry();
  for (const id of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    const impl: ApiImplementation = {
      id,
      stream: (model: Model, _context, options) => {
        calls.push({
          id: model.id,
          api: model.api,
          baseUrl: model.baseUrl,
          apiKey: options.apiKey,
        });
        const ok = (SUPPORT[model.id] ?? []).includes(model.api);
        const message = {
          role: "assistant" as const,
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: ok ? ("stop" as const) : ("error" as const),
          ...(ok ? {} : { errorMessage: "404 model not supported on this endpoint" }),
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

const deps: Pick<RuntimeDeps, "providers"> = {
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

function config(): AmaConfig {
  return JSON.parse(readFileSync(join(home.configDir, "config.json"), "utf8")) as AmaConfig;
}

const ADD = ["add", "relay", "--base-url", "https://relay.example/v1"];

describe("ama providers add", () => {
  it("--key-env + --probe：逐渠道探测，成功的渠道全部写进模型，删掉没人用的渠道；元数据不写进配置", async () => {
    const code = await runProviders(
      [
        ...ADD,
        "--key-env",
        "RELAY_KEY",
        "--probe",
        "--probe-models",
        "kimi-k2.5,grok-4.7,deepseek-flash",
        "--yes",
      ],
      io(),
      deps,
    );
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
    // kimi：提示 3 个渠道 → 3 次；grok：只提示 responses → 1 次；deepseek-flash 无提示 → 3 次
    expect(calls).toHaveLength(7);
    expect(calls.every((c) => c.apiKey === "sk-relay")).toBe(true);
    expect(calls.find((c) => c.api === "anthropic-messages")?.baseUrl).toBe(
      "https://relay.example",
    );
    const relay = config().providers?.["relay"];
    expect(relay).toMatchObject({
      apiKey: "$RELAY_KEY",
      defaultChannel: "chat",
      channels: {
        chat: { api: "openai-completions", baseUrl: "https://relay.example/v1" },
        responses: { api: "openai-responses", baseUrl: "https://relay.example/v1" },
        messages: { api: "anthropic-messages", baseUrl: "https://relay.example" },
      },
    });
    expect(relay?.models).toEqual([
      { id: "kimi-k2.5", channels: ["chat", "messages"] },
      { id: "grok-4.7", channels: ["responses"] },
      { id: "deepseek-flash", channels: ["chat", "responses", "messages"] },
      { id: "MiniMax-M2.7", channels: ["chat"] },
      { id: "qwen3-vl-flash", channels: ["chat"] },
    ]);
    const text = out.join("");
    expect(text).toContain("发现 5 个模型（https://relay.example/v1/models）");
    expect(text).toContain("models.dev：已更新");
    expect(text).toContain("探测：3 个模型、7 次最小请求");
    expect(text).toMatch(/kimi-k2\.5\s+chat,messages\s+262k\s+66k\s+是\s+是\s+是/);
    expect(text).toMatch(
      /MiniMax-M2\.7\s+chat\s+205k\s+66k\s+否.*未探测\s+原厂 minimax\/MiniMax-M2\.7/,
    );
    expect(existsAuth()).toBe(false);
  });

  it("key 从 stdin 读、存 auth.json（0600）；不探测时按提示挂渠道；非 TTY 没有 --yes → 退出 2 不写", async () => {
    expect(await runProviders(ADD, io("sk-from-stdin\n"), deps)).toBe(2);
    expect(err.join("")).toContain("非交互环境需加 --yes");
    expect(existsConfig()).toBe(false);
    err = [];
    expect(await runProviders([...ADD, "--yes"], io("sk-from-stdin\n"), deps)).toBe(0);
    expect(calls).toHaveLength(0);
    const listing = requests.find((r) => r.url.endsWith("/models"));
    expect(listing?.headers["authorization"]).toBe("Bearer sk-from-stdin");
    const relay = config().providers?.["relay"];
    expect(relay?.apiKey).toBeUndefined();
    expect(relay?.models?.find((m) => m.id === "kimi-k2.5")?.channels).toEqual([
      "chat",
      "responses",
      "messages",
    ]);
    expect(relay?.models?.find((m) => m.id === "deepseek-flash")?.channels).toEqual(["chat"]);
    const auth = join(home.configDir, "auth.json");
    expect(JSON.parse(readFileSync(auth, "utf8")).providers.relay.apiKey).toBe("sk-from-stdin");
    if (process.platform !== "win32") expect(statSync(auth).mode & 0o777).toBe(0o600);
    expect(out.join("")).not.toContain("sk-from-stdin");
  });

  it("对已存在的供应商再 add：只追加，不改手改的条目；refresh 提示已下架的", async () => {
    home.write("home/.config/ama/config.json", {
      version: 1,
      providers: {
        relay: {
          apiKey: "$RELAY_KEY",
          channels: { chat: { api: "openai-completions", baseUrl: "https://relay.example/v1" } },
          models: [
            { id: "kimi-k2.5", channels: ["chat"], contextWindow: 1000 },
            { id: "retired", channels: ["chat"] },
          ],
        },
      },
    });
    expect(await runProviders(["refresh", "relay", "--yes"], io(), deps)).toBe(0);
    const relay = config().providers?.["relay"];
    expect(relay?.models?.[0]).toEqual({
      id: "kimi-k2.5",
      channels: ["chat"],
      contextWindow: 1000,
    });
    expect(relay?.models?.map((m) => m.id)).toContain("grok-4.7");
    expect(Object.keys(relay?.channels ?? {})).toEqual(["chat"]);
    expect(out.join("")).toContain("上游已不再列出（未删除）：retired");
    expect(readFileSync(join(home.configDir, "config.json.bak"), "utf8")).toContain("retired");
  });

  it("list / channels / remove", async () => {
    await runProviders([...ADD, "--key-env", "RELAY_KEY", "--yes"], io(), deps);
    out = [];
    expect(await runProviders(["list"], io(), deps)).toBe(0);
    const listed = out.join("");
    expect(listed).toMatch(/relay {2}自定义 · 3 渠道 · 5 模型 · key \$RELAY_KEY/);
    expect(listed).toMatch(/@messages {2}anthropic-messages {2}https:\/\/relay\.example {2}1 模型/);
    out = [];
    expect(await runProviders(["channels", "relay"], io(), deps)).toBe(0);
    expect(out.join("")).toContain("@chat（缺省）  chat  openai-completions");
    out = [];
    expect(await runProviders(["remove", "relay"], io(), deps)).toBe(0);
    expect(config().providers?.["relay"]).toBeUndefined();
    expect(await runProviders(["remove", "relay"], io(), deps)).toBe(1);
  });

  it("用法错误", async () => {
    await expect(runProviders(["add", "relay"], io(), deps)).rejects.toThrow(/--base-url/);
    await expect(
      runProviders(["add", "bad@id", "--base-url", "https://x"], io(), deps),
    ).rejects.toThrow(/不合法/);
    expect(await runProviders([], io(), deps)).toBe(2);
  });
});

function existsConfig(): boolean {
  try {
    statSync(join(home.configDir, "config.json"));
    return true;
  } catch {
    return false;
  }
}

function existsAuth(): boolean {
  try {
    statSync(join(home.configDir, "auth.json"));
    return true;
  } catch {
    return false;
  }
}
