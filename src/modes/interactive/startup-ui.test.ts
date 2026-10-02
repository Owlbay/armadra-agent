import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderData, ProviderRegistryApi } from "../../ai/types.js";
import { MemoryTerminal, plainTheme } from "../../tui.js";
import { createStartupUi, modelItems, relativeTime, sessionItems } from "./startup-ui.js";

function model(provider: string, id: string, name = id) {
  return {
    id,
    name,
    provider,
    api: "fake",
    input: ["text"],
    reasoning: false,
    maxTokens: 1000,
  } as ProviderData["models"][number];
}

function registry(keys: Record<string, boolean>): ProviderRegistryApi {
  const providers: ProviderData[] = [
    {
      id: "openai",
      name: "OpenAI",
      api: "openai-responses",
      baseUrl: "",
      envKeys: ["OPENAI_API_KEY"],
      models: [model("openai", "gpt-5", "GPT-5")],
      requiresApiKey: true,
      builtin: true,
    },
    {
      id: "anthropic",
      name: "Anthropic",
      api: "anthropic-messages",
      baseUrl: "",
      envKeys: ["ANTHROPIC_API_KEY"],
      models: [model("anthropic", "claude-sonnet"), model("anthropic", "claude-haiku")],
      requiresApiKey: true,
      builtin: true,
    },
    {
      id: "ollama",
      name: "Ollama",
      api: "openai-completions",
      baseUrl: "",
      envKeys: [],
      models: [model("ollama", "qwen")],
      requiresApiKey: false,
      builtin: true,
    },
  ];
  return {
    list: () => providers,
    get: (id) => providers.find((p) => p.id === id),
    findModel: () => ({ ok: false, reason: "model_not_found", candidates: [] }) as never,
    resolveApiKey: async (id) => (keys[id] ? { apiKey: "k", source: "env" } : {}) as never,
    getApi: () => undefined,
  };
}

/** 每次问答一个 MemoryTerminal；返回最近一个。 */
function harness() {
  const terminals: MemoryTerminal[] = [];
  const ui = createStartupUi({
    theme: plainTheme(),
    now: () => Date.parse("2026-10-02T12:00:00Z"),
    terminal: () => {
      const t = new MemoryTerminal({ columns: 60, rows: 12 });
      terminals.push(t);
      return t;
    },
  });
  const last = (): MemoryTerminal => terminals[terminals.length - 1]!;
  return { ui, terminals, last };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("启动期 UI", () => {
  it("modelItems：有 key / 本地的供应商排前，组标题带 key 状态", async () => {
    const items = await modelItems(registry({ anthropic: true }));
    expect(items.map((i) => i.value)).toEqual([
      "anthropic/claude-sonnet",
      "anthropic/claude-haiku",
      "ollama/qwen",
      "openai/gpt-5",
    ]);
    expect(items[0]?.group).toBe("anthropic · key ✓");
    expect(items[2]?.group).toBe("ollama · 本地");
    expect(items[3]).toMatchObject({ group: "openai · 无 key", description: "GPT-5" });
  });

  it("pickModel：下移一项 Enter 返回 provider/id，问答收成一行留在屏幕上", async () => {
    const { ui, last } = harness();
    const pending = ui.pickModel(registry({ anthropic: true }), "供应商 openai 没有 API key");
    await tick();
    const t = last();
    expect(t.viewport().join("\n")).toContain("供应商 openai 没有 API key");
    expect(t.viewport().join("\n")).toContain("anthropic · key ✓");
    t.sendInput("\x1b[B");
    t.sendInput("\r");
    expect(await pending).toBe("anthropic/claude-haiku");
    expect(t.started).toBe(false);
    expect(t.viewport().filter((l) => l !== "")).toEqual(["? 选择模型 claude-haiku"]);
  });

  it("pickModel：输入过滤后 Enter；Esc 取消返回 undefined", async () => {
    const { ui, last } = harness();
    let pending = ui.pickModel(registry({}), "没有可用模型");
    await tick();
    last().sendInput("qw");
    last().sendInput("\r");
    expect(await pending).toBe("ollama/qwen");
    pending = ui.pickModel(registry({}), "没有可用模型");
    await tick();
    last().sendInput("\x1b");
    last().flushInput();
    expect(await pending).toBeUndefined();
    expect(last().viewport().join("\n")).toContain("（已取消）");
  });

  it("pickSession：按修改时间倒序，相对时间；空列表直接 undefined", async () => {
    const { ui, last, terminals } = harness();
    expect(await ui.pickSession([])).toBeUndefined();
    expect(terminals).toHaveLength(0);
    const base = { cwd: "/w", createdAt: "2026-10-01T00:00:00Z", messageCount: 4 };
    const pending = ui.pickSession([
      {
        ...base,
        id: "aaaa1111",
        file: "a",
        modifiedAt: "2026-10-02T11:55:00Z",
        firstPrompt: "修复\n登录",
      },
      { ...base, id: "bbbb2222", file: "b", modifiedAt: "2026-10-02T09:00:00Z", name: "重构" },
    ]);
    await tick();
    const screen = last().viewport().join("\n");
    expect(screen).toContain("修复 登录");
    expect(screen).toContain("5 分钟前 · 4 条");
    expect(screen).toContain("3 小时前");
    last().sendInput("\x1b[B\r");
    expect(await pending).toBe("bbbb2222");
  });

  it("promptTrust：缺省选中「仅本次信任」；Ctrl+C 取消 = 不信任不记住", async () => {
    const { ui, last } = harness();
    let pending = ui.promptTrust("/repo", ["/repo/.ama/hooks.json"]);
    await tick();
    expect(last().viewport().join("\n")).toContain("/repo/.ama/hooks.json");
    last().sendInput("\r");
    expect(await pending).toEqual({ trusted: true, remember: false });
    pending = ui.promptTrust("/repo", ["/repo/.ama/hooks.json"]);
    await tick();
    last().sendInput("\x1b[A\r");
    expect(await pending).toEqual({ trusted: true, remember: true });
    pending = ui.promptTrust("/repo", ["/repo/.ama/hooks.json"]);
    await tick();
    last().sendInput("\x03");
    expect(await pending).toEqual({ trusted: false, remember: false });
    // 数字直选：4 = 不信任并记住
    pending = ui.promptTrust("/repo", ["/repo/.ama/hooks.json"]);
    await tick();
    expect(last().viewport().join("\n")).toContain("1-4 直接选");
    last().sendInput("4");
    expect(await pending).toEqual({ trusted: false, remember: true });
  });

  it("askCwd：不存在的目录提示后重输，存在的返回绝对路径；Esc 取消", async () => {
    dir = mkdtempSync(join(tmpdir(), "ama-startup-"));
    const { ui, last } = harness();
    let pending = ui.askCwd("/gone/project");
    await tick();
    last().sendInput(join(dir, "nope"));
    last().sendInput("\r");
    await tick();
    expect(last().viewport().join("\n")).toContain("不存在");
    last().sendInput("\x15");
    last().sendInput(dir);
    last().sendInput("\r");
    expect(await pending).toBe(dir);
    pending = ui.askCwd("/gone/project");
    await tick();
    last().sendInput("\x1b");
    last().flushInput();
    expect(await pending).toBeUndefined();
  });

  it("sessionItems / relativeTime 边界", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    expect(relativeTime("2026-10-02T11:59:40Z", now)).toBe("刚刚");
    expect(relativeTime("2026-09-30T12:00:00Z", now)).toBe("2 天前");
    expect(relativeTime("2026-08-01T00:00:00Z", now)).toBe("2026-08-01");
    expect(relativeTime("bad", now)).toBe("");
    const items = sessionItems(
      [{ id: "cccc3333dddd", file: "c", cwd: "/", createdAt: "", modifiedAt: "", messageCount: 0 }],
      now,
    );
    expect(items[0]?.label).toBe("cccc3333");
  });
});
