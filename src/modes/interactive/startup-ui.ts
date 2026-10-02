/**
 * 启动期的迷你界面：bootstrap 第 7 / 8 / 11 步的 `InteractiveUi` 回调（实施计划 §3.3）。[B7]
 *
 * 这些回调先于交互模式运行（会话、信任、模型还没定），所以每次问答新建一个只含问题与
 * 选择列表 / 输入框的 `TUI`；答完把问答收成一行再 `stop()`——不清屏，问答留在回滚里。
 * 取消（Esc / Ctrl+C）按各回调的约定返回 undefined（bootstrap 据此给退出码）。
 *
 * `modelItems` / `sessionItems` 同时供交互模式里的选择器（pickers.ts）使用。
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Model, ProviderRegistryApi } from "../../ai/types.js";
import type { InteractiveUi } from "../../cli/deps.js";
import type { TrustPromptAnswer } from "../../config/trust.js";
import type { SessionListItem } from "../../session/types.js";
import {
  Container,
  Editor,
  ProcessTerminal,
  SelectList,
  TUI,
  Text,
  createTheme,
  defaultKeybindings,
  detectCapabilities,
  type Keybindings,
  type SelectItem,
  type Terminal,
  type Theme,
} from "../../tui.js";

export interface StartupUiOptions {
  /** 每次问答新建的终端；缺省 `new ProcessTerminal()`。 */
  terminal?: () => Terminal;
  theme?: Theme;
  keybindings?: Keybindings;
  /** 会话列表的相对时间基准（测试注入）。 */
  now?: () => number;
}

interface Prompt {
  title: string;
  lines?: readonly string[];
}

interface Resolved {
  terminal: () => Terminal;
  theme: Theme;
  keys: Keybindings;
  now: () => number;
}

function resolveOptions(options: StartupUiOptions): Resolved {
  return {
    terminal: options.terminal ?? (() => new ProcessTerminal()),
    theme: options.theme ?? createTheme("dark", { caps: detectCapabilities() }),
    keys: options.keybindings ?? defaultKeybindings,
    now: options.now ?? Date.now,
  };
}

/** 一个问题 + 正文的迷你 TUI；`finish(answer)` 把界面收成一行「标题 → 答案」后交还终端。 */
function miniTui(r: Resolved, prompt: Prompt) {
  const tui = new TUI(r.terminal(), { anchorToTop: false });
  const body = new Container();
  body.addChild(new Text(r.theme.fg("accent", "? ") + r.theme.bold(prompt.title)));
  for (const line of prompt.lines ?? []) body.addChild(new Text(r.theme.fg("dim", line)));
  tui.addChild(body);
  const finish = (answer: string): void => {
    tui.clear();
    tui.addChild(
      new Text(
        r.theme.fg("accent", "? ") + r.theme.bold(prompt.title) + " " + r.theme.fg("dim", answer),
      ),
    );
    tui.renderNow();
    tui.stop();
  };
  return { tui, body, finish };
}

/** 选择题：返回选中项，Esc / Ctrl+C 返回 undefined。 */
function askSelect(
  r: Resolved,
  prompt: Prompt & { items: readonly SelectItem[]; selected?: string; filterable?: boolean },
): Promise<SelectItem | undefined> {
  return new Promise((done) => {
    const { tui, body, finish } = miniTui(r, prompt);
    const list = new SelectList(prompt.items, {
      theme: r.theme,
      keybindings: r.keys,
      maxVisible: 10,
      filterable: prompt.filterable === true,
      onSelect: (item) => {
        finish(item.label);
        done(item);
      },
      onCancel: () => {
        finish("（已取消）");
        done(undefined);
      },
    });
    if (prompt.selected !== undefined) list.selectValue(prompt.selected);
    body.addChild(list);
    body.addChild(
      new Text(
        r.theme.fg(
          "dim",
          prompt.filterable === true
            ? "输入过滤 · ↑↓ 选择 · Enter 确认 · Esc 取消"
            : "↑↓ 选择 · Enter 确认 · Esc 取消",
        ),
      ),
    );
    tui.start();
    tui.setFocus(list);
  });
}

/** 填空题：`validate` 返回错误文本时留在原地重输；Esc / Ctrl+C 返回 undefined。 */
function askText(
  r: Resolved,
  prompt: Prompt & { placeholder?: string; validate?(text: string): string | undefined },
): Promise<string | undefined> {
  return new Promise((done) => {
    const { tui, body, finish } = miniTui(r, prompt);
    const error = new Text("");
    const editor = new Editor({
      theme: r.theme,
      keybindings: r.keys,
      maxVisibleLines: 3,
      requestRender: () => tui.requestRender(),
      ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
      onSubmit: (text) => {
        const value = text.trim();
        const problem = prompt.validate?.(value);
        if (problem !== undefined) {
          error.setText(r.theme.fg("error", problem));
          editor.setText(value);
          return;
        }
        finish(value);
        done(value);
      },
    });
    body.addChild(editor);
    body.addChild(error);
    tui.addInputListener((data) => {
      if (r.keys.matches(data, "tui.select.cancel") && !editor.isCompletionOpen) {
        finish("（已取消）");
        done(undefined);
        return true;
      }
      return false;
    });
    tui.start();
    tui.setFocus(editor);
  });
}

// ---------------------------------------------------------------------------
// 列表项（选择器共用）
// ---------------------------------------------------------------------------

/** 选择器里模型的说明：名称（与 id 不同时）、上下文、`img`（收图片）。 */
export function modelDescription(model: Model): string | undefined {
  const ctx = model.contextWindow;
  const parts = [
    model.name !== "" && model.name !== model.id ? model.name : undefined,
    ctx === undefined
      ? undefined
      : ctx >= 1_000_000
        ? `${Math.round(ctx / 100_000) / 10}M`
        : `${Math.round(ctx / 1000)}k`,
    model.input.includes("image") ? "img" : undefined,
  ].filter((x) => x !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * 模型按「供应商 · 渠道」分组；有 key（或本地）的供应商排前，组标题标 key 状态。多渠道供应商的模型在
 * 每个挂载的渠道下各出现一次，非首选渠道的值带 `@渠道`。
 */
export async function modelItems(providers: ProviderRegistryApi): Promise<SelectItem[]> {
  const groups: { ready: boolean; items: SelectItem[] }[] = [];
  for (const provider of providers.list()) {
    if (provider.models.length === 0) continue;
    let status: string;
    let ready = true;
    if (!provider.requiresApiKey) status = "本地";
    else {
      const key = await providers.resolveApiKey(provider.id).catch(() => ({ apiKey: undefined }));
      ready = key.apiKey !== undefined;
      status = ready ? "key ✓" : "无 key";
    }
    const item = (model: Model, group: string, channel?: string): SelectItem => {
      const suffix = channel !== undefined && channel !== model.channel ? `@${channel}` : "";
      const out: SelectItem = {
        value: `${provider.id}/${model.id}${suffix}`,
        label: `${model.id}${suffix}`,
        group,
      };
      const description = modelDescription(model);
      if (description !== undefined) out.description = description;
      return out;
    };
    if (provider.channels === undefined) {
      const group = `${provider.id} · ${status}`;
      groups.push({ ready, items: provider.models.map((model) => item(model, group)) });
      continue;
    }
    for (const channel of provider.channels) {
      const group = `${provider.id} · ${channel.name} · ${status}`;
      const models = provider.models.filter((m) => m.channels?.includes(channel.name));
      if (models.length > 0)
        groups.push({ ready, items: models.map((model) => item(model, group, channel.name)) });
    }
  }
  return [...groups.filter((g) => g.ready), ...groups.filter((g) => !g.ready)].flatMap(
    (g) => g.items,
  );
}

/** `刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 2026-09-01`。 */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return iso.slice(0, 10);
}

function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 会话：标签 = 名字或首条提示，描述 = 相对时间 · 消息数。 */
export function sessionItems(items: readonly SessionListItem[], now: number): SelectItem[] {
  return [...items]
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .map((item) => ({
      value: item.id,
      label: oneLine(item.name ?? item.firstPrompt ?? item.id.slice(0, 8)),
      description: `${relativeTime(item.modifiedAt, now)} · ${item.messageCount} 条`,
    }));
}

// ---------------------------------------------------------------------------
// InteractiveUi
// ---------------------------------------------------------------------------

const TRUST_CHOICES: readonly (SelectItem & { answer: TrustPromptAnswer })[] = [
  { value: "trust", label: "信任并记住", answer: { trusted: true, remember: true } },
  { value: "once", label: "仅本次信任", answer: { trusted: true, remember: false } },
  { value: "skip", label: "本次不信任", answer: { trusted: false, remember: false } },
  { value: "never", label: "不信任并记住", answer: { trusted: false, remember: true } },
];

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createStartupUi(options: StartupUiOptions = {}): Required<InteractiveUi> {
  const r = resolveOptions(options);
  return {
    async promptTrust(cwd, resources) {
      const shown = resources.slice(0, 6).map((p) => `  ${p}`);
      if (resources.length > shown.length)
        shown.push(`  …另有 ${resources.length - shown.length} 项`);
      const picked = await askSelect(r, {
        title: "信任这个目录的项目资源？",
        lines: [cwd, ...shown],
        items: TRUST_CHOICES.map(({ value, label }) => ({ value, label })),
        selected: "once",
      });
      const choice = TRUST_CHOICES.find((c) => c.value === picked?.value);
      return choice?.answer ?? { trusted: false, remember: false };
    },

    async pickSession(items) {
      if (items.length === 0) return undefined;
      const picked = await askSelect(r, {
        title: "恢复哪个会话？",
        items: sessionItems(items, r.now()),
        filterable: true,
      });
      return picked?.value;
    },

    async pickModel(providers, reason) {
      const items = await modelItems(providers);
      if (items.length === 0) return undefined;
      const picked = await askSelect(r, {
        title: "选择模型",
        lines: [reason],
        items,
        filterable: true,
      });
      return picked?.value;
    },

    askCwd(missing) {
      return askText(r, {
        title: "会话的工作目录不存在",
        lines: [missing, "输入替代目录（Enter 确认 · Esc 取消）"],
        placeholder: "目录路径",
        validate: (text) => {
          if (text === "") return "请输入目录";
          const abs = resolve(text);
          if (!existsSync(abs)) return `不存在：${abs}`;
          if (!isDirectory(abs)) return `不是目录：${abs}`;
          return undefined;
        },
      });
    },
  };
}
