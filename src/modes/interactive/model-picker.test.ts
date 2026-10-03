/**
 * `/model` 选择器本体：Tab 切视图、Space 改清单、`@` 列渠道、未配置供应商的提示；帧黄金 zh + en，80 / 40 列。
 * 更新：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive/model-picker.test.ts`。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ProviderData, ProviderRegistryApi } from "../../ai/types.js";
import { setLocale } from "../../i18n/index.js";
import { Box, plainTheme, type Component, type OverlayOptions } from "../../tui.js";
import { loadModelCatalog } from "./model-items.js";
import { ModelPickerView, openModelPicker, type ModelPickerOptions } from "./model-picker.js";
import type { PickerHost } from "./pickers.js";
import { golden, lines } from "./test-support.js";

afterEach(() => setLocale("zh"));

function provider(
  id: string,
  models: { id: string; channels?: string[]; contextWindow?: number }[],
  requiresApiKey = true,
): ProviderData {
  const channels = [...new Set(models.flatMap((m) => m.channels ?? []))];
  return {
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "",
    envKeys: [],
    models: models.map((m) => ({
      id: m.id,
      name: m.id,
      provider: id,
      api: "openai-responses",
      input: ["text"],
      reasoning: false,
      maxTokens: 1000,
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.channels !== undefined ? { channels: m.channels, channel: m.channels[0] } : {}),
    })),
    ...(channels.length > 0
      ? {
          channels: channels.map((name) => ({ name, api: "openai-responses", baseUrl: "" })),
          defaultChannel: channels[0],
        }
      : {}),
    requiresApiKey,
    builtin: true,
  } as ProviderData;
}

const PROVIDERS = [
  provider("packy", [
    { id: "claude-opus-4", channels: ["messages", "chat"], contextWindow: 200_000 },
    { id: "gpt-5", channels: ["responses"], contextWindow: 400_000 },
  ]),
  provider("openai", [{ id: "gpt-5" }, { id: "gpt-5-mini" }]),
  provider("ollama", [{ id: "qwen3" }], false),
];

function registry(keys: string[]): ProviderRegistryApi {
  return {
    list: () => PROVIDERS,
    get: (id) => PROVIDERS.find((p) => p.id === id),
    findModel: () => ({ ok: false, reason: "not_found", candidates: [] }) as never,
    resolveApiKey: async (id) =>
      keys.includes(id) ? { apiKey: "k", source: "env" } : { apiKey: undefined, source: "none" },
    getApi: () => undefined,
  };
}

const host: PickerHost = {
  theme: plainTheme(),
  showOverlay: () => ({ hide: () => undefined }) as never,
  columns: () => 80,
};

async function picker(options: Partial<ModelPickerOptions> = {}) {
  const saved: (string[] | undefined)[] = [];
  const result: { ref?: string | undefined; done: boolean } = { done: false };
  const catalog = await loadModelCatalog(registry(["packy"]));
  const view = new ModelPickerView(
    host,
    catalog,
    {
      title: "选择模型",
      providers: registry(["packy"]),
      current: "packy/claude-opus-4",
      saveEnabled: (next) => void saved.push(next),
      ...options,
    },
    (ref) => {
      result.ref = ref;
      result.done = true;
    },
  );
  const box = new Box(view, { title: options.title ?? "选择模型", theme: plainTheme() });
  const frame = (label: string, width: number): string =>
    [`# ${label} · ${width}`, ...lines(box, width)].join("\n");
  return { view, saved, result, frame };
}

describe("ModelPickerView", () => {
  it("缺省只列已配置；Tab 切到全部再切回，过滤文本保留", async () => {
    const p = await picker();
    expect(p.view.list.getItems().map((i) => i.value)).toEqual([
      "packy/claude-opus-4",
      "packy/gpt-5",
      "ollama/qwen3",
    ]);
    p.view.handleInput("g");
    p.view.handleInput("\t");
    expect(p.view.currentView).toBe("all");
    expect(p.view.list.getFilter()).toBe("g");
    expect(p.view.list.getItems().map((i) => i.value)).toEqual([
      "packy/gpt-5",
      "openai/gpt-5",
      "openai/gpt-5-mini",
    ]);
    p.view.handleInput("\t");
    expect(p.view.currentView).toBe("configured");
  });

  it("筛选文本含 @ 时列出渠道行，可直接选 @渠道", async () => {
    const p = await picker();
    for (const ch of "@chat") p.view.handleInput(ch);
    // 主行的说明「另有 @chat」也匹配
    expect(p.view.list.getItems().map((i) => i.value)).toEqual([
      "packy/claude-opus-4",
      "packy/claude-opus-4@chat",
    ]);
    p.view.handleInput("\x1b[B");
    p.view.handleInput("\r");
    expect(p.result).toEqual({ ref: "packy/claude-opus-4@chat", done: true });
  });

  it("全部视图选中未配置 key 的模型：不切换，底部提示 ama auth set", async () => {
    const p = await picker();
    p.view.handleInput("\t");
    p.view.list.selectValue("openai/gpt-5-mini");
    p.view.handleInput("\r");
    expect(p.result.done).toBe(false);
    expect(p.frame("no key", 72)).toContain("openai 未配置 key：运行 ama auth set openai");
  });

  it("Space 加入 / 移出清单；第一次加入后已配置视图只剩清单内（加当前）", async () => {
    const p = await picker();
    p.view.list.selectValue("ollama/qwen3");
    p.view.handleInput(" ");
    expect(p.saved).toEqual([["ollama/qwen3"]]);
    expect(p.view.list.getItems().map((i) => i.value)).toEqual([
      "packy/claude-opus-4",
      "ollama/qwen3",
    ]);
    expect(p.frame("added", 72)).toContain("/model 之后只显示清单内的模型");
    p.view.list.selectValue("ollama/qwen3");
    p.view.handleInput(" ");
    expect(p.saved.at(-1)).toBeUndefined();
    expect(p.view.list.getItems()).toHaveLength(3);
  });

  it("只经 provider/* 列入的不能单独移出；写失败显示错误、清单不变", async () => {
    const p = await picker({ enabled: ["packy/*"] });
    p.view.list.selectValue("packy/gpt-5");
    p.view.handleInput(" ");
    expect(p.saved).toEqual([]);
    expect(p.frame("wildcard", 72)).toContain("经 packy/* 列入清单");
    const failing = await picker({
      enabled: ["packy/*"],
      saveEnabled: () => {
        throw new Error("写入失败 X");
      },
    });
    failing.view.handleInput("\t");
    failing.view.list.selectValue("ollama/qwen3");
    failing.view.handleInput("\r");
    expect(failing.result.done).toBe(false);
    expect(failing.frame("error", 72)).toContain("写入失败 X");
  });

  it("在用清单时从全部视图选中清单外的模型：先加入清单再切换", async () => {
    const p = await picker({ enabled: ["packy/gpt-5"] });
    p.view.handleInput("\t");
    p.view.list.selectValue("ollama/qwen3");
    p.view.handleInput("\r");
    expect(p.saved).toEqual([["packy/gpt-5", "ollama/qwen3"]]);
    expect(p.result).toEqual({ ref: "ollama/qwen3", done: true });
  });

  for (const locale of ["zh", "en"] as const) {
    it(`帧黄金 ${locale}（80 / 40 列）`, async () => {
      setLocale(locale);
      const frames: string[] = [];
      for (const width of [72, 38]) {
        const p = await picker({ title: locale === "zh" ? "选择模型" : "Select model" });
        frames.push(p.frame("configured", width));
        p.view.handleInput("\t");
        frames.push(p.frame("all", width));
        p.view.handleInput("@");
        frames.push(p.frame("all + @", width));
        p.view.handleInput("\x7f");
        p.view.handleInput("\t");
        p.view.list.selectValue("packy/gpt-5");
        p.view.handleInput(" ");
        frames.push(p.frame("space", width));
      }
      golden(`model-picker-${locale}`, `${frames.join("\n")}\n`);
    });
  }
});

describe("openModelPicker", () => {
  it("覆盖层居中、宽度随终端；Esc 返回 undefined", async () => {
    let shown: { component: Component; options: OverlayOptions } | undefined;
    let hidden = false;
    const pending = openModelPicker(
      {
        ...host,
        columns: () => 40,
        showOverlay: (component, options) => {
          shown = { component, options };
          return { hide: () => (hidden = true) } as never;
        },
      },
      { title: "选择模型", providers: registry([]), saveEnabled: () => undefined },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(shown?.options).toMatchObject({ anchor: "center", width: 38 });
    expect(lines(shown!.component, 38).join("\n")).toContain("ollama · 本地");
    shown!.component.handleInput?.("\x1b");
    expect(await pending).toBeUndefined();
    expect(hidden).toBe(true);
  });
});
