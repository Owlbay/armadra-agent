/**
 * 键位表（设计 §12.3）：动作 id → KeyId 列表；固定缺省表 + `keybindings.json` 覆盖。[B4]
 *
 * - `tui.*` 由组件库自己消费（编辑器、选择列表）；`app.*` 供交互模式（B7）分派。
 * - 覆盖时整组替换；空数组表示禁用该动作。未知动作 id 与非字符串键会被报告并忽略。
 * - 文件位置由调用方决定（配置目录归 B5），这里只负责解析与合并。
 */

import { readFileSync } from "node:fs";
import { normalizeKeyId, parseKey } from "./keys.js";

export const DEFAULT_KEYBINDINGS = {
  "tui.editor.submit": ["enter"],
  "tui.editor.newLine": ["shift+enter", "ctrl+j"],
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorUp": ["up", "ctrl+p"],
  "tui.editor.cursorDown": ["down", "ctrl+n"],
  "tui.editor.wordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "tui.editor.wordRight": ["alt+right", "ctrl+right", "alt+f"],
  "tui.editor.lineStart": ["home", "ctrl+a"],
  "tui.editor.lineEnd": ["end", "ctrl+e"],
  "tui.editor.deleteBackward": ["backspace", "shift+backspace"],
  "tui.editor.deleteForward": ["delete"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace", "ctrl+backspace"],
  "tui.editor.deleteWordForward": ["alt+d", "alt+delete", "ctrl+delete"],
  "tui.editor.deleteToLineStart": ["ctrl+u"],
  "tui.editor.deleteToLineEnd": ["ctrl+k"],
  "tui.editor.undo": ["ctrl+z", "ctrl+-"],
  "tui.editor.complete": ["tab"],
  "tui.select.up": ["up", "ctrl+p"],
  "tui.select.down": ["down", "ctrl+n"],
  "tui.select.pageUp": ["pageup"],
  "tui.select.pageDown": ["pagedown"],
  "tui.select.confirm": ["enter", "tab"],
  "tui.select.cancel": ["escape", "ctrl+c"],
  "app.interrupt": ["escape"],
  "app.rewind": ["escape"],
  "app.clear": ["ctrl+c"],
  "app.exit": ["ctrl+d"],
  "app.message.followUp": ["alt+enter"],
  "app.message.dequeue": ["alt+up"],
  "app.permission.cycle": ["shift+tab"],
  "app.tools.expand": ["ctrl+o"],
  "app.model.select": ["ctrl+l"],
  "app.thinking.select": ["ctrl+t"],
} as const satisfies Record<string, readonly string[]>;

export type ActionId = keyof typeof DEFAULT_KEYBINDINGS;

export type KeybindingOverrides = Partial<Record<ActionId, readonly string[]>>;

export interface ParsedKeybindings {
  overrides: KeybindingOverrides;
  /** 被忽略的条目说明（未知动作、类型错误）。 */
  warnings: string[];
}

export function isActionId(id: string): id is ActionId {
  return Object.prototype.hasOwnProperty.call(DEFAULT_KEYBINDINGS, id);
}

/** 解析 keybindings.json 的对象形状：`{ "<action>": "key" | ["key", ...] }`。 */
export function parseKeybindings(value: unknown): ParsedKeybindings {
  const overrides: Record<string, readonly string[]> = {};
  const warnings: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { overrides: {}, warnings: ["keybindings 必须是对象"] };
  }
  for (const [action, keys] of Object.entries(value as Record<string, unknown>)) {
    if (!isActionId(action)) {
      warnings.push(`未知动作：${action}`);
      continue;
    }
    const list = typeof keys === "string" ? [keys] : keys;
    if (!Array.isArray(list) || !list.every((k) => typeof k === "string")) {
      warnings.push(`${action}：键必须是字符串或字符串数组`);
      continue;
    }
    overrides[action] = list.map((k) => normalizeKeyId(k));
  }
  return { overrides: overrides as KeybindingOverrides, warnings };
}

/** 读取并解析 keybindings.json；文件不存在返回空覆盖，JSON 错误记入 warnings。 */
export function loadKeybindingsFile(path: string): ParsedKeybindings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { overrides: {}, warnings: [] };
    return { overrides: {}, warnings: [`读取 ${path} 失败：${(error as Error).message}`] };
  }
  try {
    return parseKeybindings(JSON.parse(text));
  } catch (error) {
    return { overrides: {}, warnings: [`${path} 不是合法 JSON：${(error as Error).message}`] };
  }
}

export class Keybindings {
  private readonly table: Map<ActionId, readonly string[]>;

  constructor(overrides: KeybindingOverrides = {}) {
    this.table = new Map();
    for (const action of Object.keys(DEFAULT_KEYBINDINGS) as ActionId[]) {
      const keys = overrides[action] ?? DEFAULT_KEYBINDINGS[action];
      this.table.set(
        action,
        keys.map((k) => normalizeKeyId(k)),
      );
    }
  }

  /** 动作绑定的 KeyId 列表（已规范化）。 */
  keys(action: ActionId): readonly string[] {
    return this.table.get(action) ?? [];
  }

  /** 原始输入数据是否触发该动作。 */
  matches(data: string, action: ActionId): boolean {
    const key = parseKey(data);
    if (key === undefined) return false;
    return this.keys(action).includes(key.id);
  }

  /** 输入数据触发的全部动作（按缺省表顺序），用于分派。 */
  actionsFor(data: string): ActionId[] {
    const key = parseKey(data);
    if (key === undefined) return [];
    const out: ActionId[] = [];
    for (const [action, keys] of this.table) if (keys.includes(key.id)) out.push(action);
    return out;
  }
}

/** 进程内共享的缺省键位（组件未显式传入时使用）。 */
export const defaultKeybindings = new Keybindings();
