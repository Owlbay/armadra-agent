/**
 * 启动期的迷你界面：bootstrap 第 7 / 8 / 11 步的 `InteractiveUi` 回调（实施计划 §3.3）。[B7]
 *
 * 这些回调先于交互模式运行（会话、信任、模型还没定），所以每次问答新建一个只含问题与
 * 选择列表 / 输入框的 `TUI`；答完把问答收成一行再 `stop()`——不清屏，问答留在回滚里。
 * 取消（Esc / Ctrl+C）按各回调的约定返回 undefined（bootstrap 据此给退出码）。
 *
 * `modelItems`（model-items.ts）/ `sessionItems` 同时供交互模式里的选择器（pickers.ts）使用。启动选择器只列
 * 已配置的模型，一个都没有时列全部。
 */

import { msg } from "../../i18n/index.js";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
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
import { loadModelCatalog, catalogItems } from "./model-items.js";

export { modelDescription, modelItems } from "./model-items.js";

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
  prompt: Prompt & {
    items: readonly SelectItem[];
    selected?: string;
    filterable?: boolean;
    /** 右侧序号，按数字直选（不与 filterable 同用）。 */
    numberKeys?: boolean;
  },
): Promise<SelectItem | undefined> {
  return new Promise((done) => {
    const { tui, body, finish } = miniTui(r, prompt);
    const list = new SelectList(prompt.items, {
      theme: r.theme,
      keybindings: r.keys,
      maxVisible: 10,
      filterable: prompt.filterable === true,
      ...(prompt.numberKeys === true ? { numberKeys: true } : {}),
      onSelect: (item) => {
        finish(item.label);
        done(item);
      },
      onCancel: () => {
        finish(msg().interactive.startup.ui.cancelled);
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
            ? msg().interactive.startup.ui.hintFilter("↑↓")
            : prompt.numberKeys === true
              ? msg().interactive.startup.ui.hintNumbers("↑↓", prompt.items.length)
              : msg().interactive.startup.ui.hint("↑↓"),
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
        finish(msg().interactive.startup.ui.cancelled);
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

/** `刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 2026-09-01`。 */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const m = msg().interactive.startup.ui;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return m.justNow;
  if (minutes < 60) return m.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return m.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return m.daysAgo(days);
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
      description: `${relativeTime(item.modifiedAt, now)} · ${msg().interactive.startup.ui.messages(item.messageCount)}`,
    }));
}

// ---------------------------------------------------------------------------
// InteractiveUi
// ---------------------------------------------------------------------------

function trustChoices(): (SelectItem & { answer: TrustPromptAnswer })[] {
  const m = msg().interactive.startup.ui;
  return [
    { value: "trust", label: m.trustRemember, answer: { trusted: true, remember: true } },
    { value: "once", label: m.trustOnce, answer: { trusted: true, remember: false } },
    { value: "skip", label: m.trustSkip, answer: { trusted: false, remember: false } },
    { value: "never", label: m.trustNever, answer: { trusted: false, remember: true } },
  ];
}

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
      const m = msg().interactive.startup.ui;
      const choices = trustChoices();
      const shown = resources.slice(0, 6).map((p) => `  ${p}`);
      if (resources.length > shown.length)
        shown.push(m.moreResources(resources.length - shown.length));
      const picked = await askSelect(r, {
        title: m.trustTitle,
        lines: [cwd, ...shown],
        items: choices.map(({ value, label }) => ({ value, label })),
        selected: "once",
        numberKeys: true,
      });
      const choice = choices.find((c) => c.value === picked?.value);
      return choice?.answer ?? { trusted: false, remember: false };
    },

    async pickSession(items) {
      if (items.length === 0) return undefined;
      const picked = await askSelect(r, {
        title: msg().interactive.startup.ui.resumeTitle,
        items: sessionItems(items, r.now()),
        filterable: true,
      });
      return picked?.value;
    },

    async pickModel(providers, reason) {
      const catalog = await loadModelCatalog(providers);
      let items = catalogItems(catalog, { hints: false });
      if (items.length === 0) items = catalogItems(catalog, { view: "all", hints: false });
      if (items.length === 0) return undefined;
      const picked = await askSelect(r, {
        title: msg().interactive.startup.ui.modelTitle,
        lines: [reason],
        items,
        filterable: true,
      });
      return picked?.value;
    },

    askCwd(missing) {
      const m = msg().interactive.startup.ui;
      return askText(r, {
        title: m.cwdTitle,
        lines: [missing, m.cwdPrompt],
        placeholder: m.cwdPlaceholder,
        validate: (text) => {
          if (text === "") return m.cwdEmpty;
          const abs = resolve(text);
          if (!existsSync(abs)) return m.cwdMissing(abs);
          if (!isDirectory(abs)) return m.cwdNotDir(abs);
          return undefined;
        },
      });
    },
  };
}
