import { describe, expect, it } from "vitest";
import { listChatGptModels, usageUrl } from "./backend-client.js";
import { DEFAULT_CODEX_CLIENT_VERSION, codexClientVersion } from "./presets.js";

function recorder(body: unknown): {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify(body));
    },
  };
}

describe("ChatGPT 模型列表", () => {
  it("SIWC：/models，按 visibility 筛，只取 id；只发 Bearer", async () => {
    const r = recorder({
      data: [
        { id: "gpt-6-sol", visibility: "list" },
        { id: "hidden-1", visibility: "hide" },
        { id: "gpt-5.5" },
      ],
    });
    const models = await listChatGptModels(r.fetch, "https://api.openai.com/v1/", {
      flavor: "siwc",
      accessToken: "t",
    });
    expect(models).toEqual([{ id: "gpt-6-sol" }, { id: "gpt-5.5" }]);
    expect(r.calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(r.calls[0]?.headers).toEqual({ authorization: "Bearer t", accept: "application/json" });
  });

  it("SIWC：条目带 context_window 同样取（max_context_window / auto_compact_token_limit 不取）", async () => {
    const r = recorder({
      data: [
        {
          id: "gpt-6-sol",
          context_window: 272000,
          max_context_window: 1000000,
          auto_compact_token_limit: 244800,
        },
      ],
    });
    const models = await listChatGptModels(r.fetch, "https://api.openai.com/v1", {
      flavor: "siwc",
      accessToken: "t",
    });
    expect(models).toEqual([{ id: "gpt-6-sol", contextWindow: 272000 }]);
  });

  it("codex：client_version、slug 与显示名、账户头与 originator", async () => {
    const r = recorder({
      models: [
        { slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list" },
        { slug: "codex-auto-review", visibility: "hide" },
      ],
    });
    const models = await listChatGptModels(r.fetch, "https://chatgpt.com/backend-api/codex", {
      flavor: "codex",
      accessToken: "t",
      accountId: "acct",
    });
    expect(models).toEqual([{ id: "gpt-6-sol", name: "GPT-6 Sol" }]);
    expect(r.calls[0]?.url).toMatch(/\/codex\/models\?client_version=\d+\.\d+\.\d+/);
    expect(r.calls[0]?.headers).toMatchObject({
      "ChatGPT-Account-ID": "acct",
      originator: "codex_cli_rs",
    });
    expect(usageUrl("https://chatgpt.com/backend-api/codex/")).toBe(
      "https://chatgpt.com/backend-api/wham/usage",
    );
  });

  it("codex：client_version 缺省是 Codex CLI 版本（不是 ama 版本），可覆盖；元数据只取认识的形状", async () => {
    const r = recorder({
      models: [
        {
          slug: "gpt-6-sol",
          context_window: 272000,
          input_modalities: ["text", "image", "audio"],
          supported_reasoning_levels: [{ effort: "low", description: "x" }, "high", { effort: 3 }],
        },
        { slug: "odd", context_window: "big", input_modalities: ["image"] },
      ],
    });
    const auth = { flavor: "codex" as const, accessToken: "t" };
    const models = await listChatGptModels(r.fetch, "https://h/codex", auth);
    expect(r.calls[0]?.url).toBe(
      `https://h/codex/models?client_version=${DEFAULT_CODEX_CLIENT_VERSION}`,
    );
    expect(models).toEqual([
      {
        id: "gpt-6-sol",
        contextWindow: 272000,
        input: ["text", "image"],
        reasoningLevels: ["low", "high"],
      },
      { id: "odd" },
    ]);
    await listChatGptModels(r.fetch, "https://h/codex", { ...auth, clientVersion: "0.150.0" });
    expect(r.calls[1]?.url).toBe("https://h/codex/models?client_version=0.150.0");
    expect(codexClientVersion({ codexClientVersion: "0.170.0" }, {})).toBe("0.170.0");
    expect(
      codexClientVersion(
        { codexClientVersion: "0.170.0" },
        { AMA_CHATGPT_CODEX_CLIENT_VERSION: " 0.180.0 " },
      ),
    ).toBe("0.180.0");
    expect(codexClientVersion(undefined, {})).toBe(DEFAULT_CODEX_CLIENT_VERSION);
  });
});
