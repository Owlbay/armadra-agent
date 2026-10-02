/**
 * 交互模式里的选择器（设计 §12.6）：居中覆盖层 + `SelectList`。[B7]
 *
 * - 模型：按供应商分组并标 key 状态（`modelItems`，与启动期共用），当前模型预选；
 * - 会话：名字或首条提示、相对时间、消息数（`sessionItems`）；
 * - 树：会话文件里全部用户消息，按分叉缩进，`●` 标出当前分支；选中项回填编辑器（由 commands.ts 处理）；
 * - 权限模式（标题「权限模式」，界面顺序 1–6，当前模式 ✓ / Default dim / Recommended accent，底部按键提示，
 *   上下留白，见 permissionItems）与思考级别；
 * - 所有选择器底部一行按键提示（dim），模型选择器带 (i/n) 并给当前模型打 ✓。
 */

import type { ModelThinkingLevel } from "../../ai/types.js";
import { THINKING_LEVELS } from "../../ai/thinking.js";
import {
  PERMISSION_MODE_INFO,
  PERMISSION_MODE_ORDER,
  RECOMMENDED_PERMISSION_MODE,
} from "../../permissions/modes.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { SessionEntry } from "../../session/types.js";
import {
  Box,
  SelectList,
  type Keybindings,
  type OverlayHandle,
  type OverlayOptions,
  type SelectItem,
  type Theme,
  type Component,
} from "../../tui.js";
import { contentText } from "./message-view.js";
import { relativeTime } from "./startup-ui.js";

export { modelItems, sessionItems } from "./startup-ui.js";

export interface PickerHost {
  theme: Theme;
  keybindings?: Keybindings;
  showOverlay(component: Component, options: OverlayOptions): OverlayHandle;
  /** 终端列数（决定覆盖层宽度）。 */
  columns(): number;
}

export interface PickerSpec {
  title: string;
  items: readonly SelectItem[];
  selected?: string;
  filterable?: boolean;
  maxVisible?: number;
  emptyText?: string;
  /** 右侧序号 1–9，按数字直接选中。 */
  numberKeys?: boolean;
  /** 说明放在标签下一行。 */
  stacked?: boolean;
  /** 当前值（标 ✓）。 */
  currentValue?: string;
  /** 列表下的按键提示，缺省「↑↓ 选择 · Enter 确认 · Esc 取消」。 */
  footer?: string;
  /** 提示行前带 (i/n)。 */
  showCount?: boolean;
  /** 框内上下留白行数。 */
  paddingY?: number;
}

export const PICKER_FOOTER = "↑↓ 选择 · Enter 确认 · Esc 取消";

/** 打开一个居中选择器；Enter 返回选中项，Esc / Ctrl+C 返回 undefined。 */
export function openPicker(host: PickerHost, spec: PickerSpec): Promise<SelectItem | undefined> {
  return new Promise((resolve) => {
    let handle: OverlayHandle | undefined;
    const close = (item: SelectItem | undefined): void => {
      handle?.hide();
      resolve(item);
    };
    const list = new SelectList(spec.items, {
      theme: host.theme,
      maxVisible: spec.maxVisible ?? 12,
      filterable: spec.filterable ?? spec.items.length > 8,
      ...(host.keybindings !== undefined ? { keybindings: host.keybindings } : {}),
      ...(spec.emptyText !== undefined ? { emptyText: spec.emptyText } : {}),
      ...(spec.numberKeys === true ? { numberKeys: true } : {}),
      ...(spec.stacked === true ? { stacked: true } : {}),
      ...(spec.currentValue !== undefined ? { currentValue: spec.currentValue } : {}),
      ...(spec.showCount === true ? { showCount: true } : {}),
      footer: spec.footer ?? PICKER_FOOTER,
      onSelect: (item) => close(item),
      onCancel: () => close(undefined),
    });
    if (spec.selected !== undefined) list.selectValue(spec.selected);
    const width = Math.max(20, Math.min(host.columns() - 2, 72));
    const box = new Box(list, {
      title: spec.title,
      theme: host.theme,
      ...(spec.paddingY !== undefined ? { paddingY: spec.paddingY } : {}),
    });
    handle = host.showOverlay(box, {
      anchor: "center",
      width,
    });
  });
}

/**
 * 模式选择器（标题「权限模式」）：界面顺序、当前模式打勾（`currentValue`）、配置里的缺省模式标
 * `Default`、Auto 标 `Recommended`，右侧数字快捷键 1–6，说明在下一行。
 */
export function permissionItems(
  _current: PermissionMode,
  configDefault: PermissionMode = "default",
): SelectItem[] {
  return PERMISSION_MODE_ORDER.map((mode) => {
    const info = PERMISSION_MODE_INFO[mode];
    const item: SelectItem = { value: mode, label: info.label, description: info.description };
    const badges = [
      ...(mode === configDefault ? ["Default"] : []),
      ...(mode === RECOMMENDED_PERMISSION_MODE ? ["Recommended"] : []),
    ];
    if (badges.length > 0) {
      item.badge = badges.join(" · ");
      if (mode !== RECOMMENDED_PERMISSION_MODE) item.badgeColor = "dim";
    }
    return item;
  });
}

export function permissionPickerSpec(
  current: PermissionMode,
  configDefault: PermissionMode = "default",
): PickerSpec {
  return {
    title: "权限模式",
    items: permissionItems(current, configDefault),
    selected: current,
    currentValue: current,
    filterable: false,
    numberKeys: true,
    stacked: true,
    footer: "↑↓ 选择 · 1-6 直接选 · Enter 确认 · Esc 取消",
    paddingY: 1,
  };
}

export function thinkingItems(reasoning: boolean): SelectItem[] {
  return THINKING_LEVELS.map((level: ModelThinkingLevel) => {
    const item: SelectItem = { value: level, label: level };
    if (!reasoning && level !== "off") item.description = "当前模型不支持思考";
    return item;
  });
}

export interface TreeNode {
  entry: SessionEntry;
  text: string;
  children: TreeNode[];
}

function userText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  return contentText(entry.message.content).replace(/\s+/g, " ").trim();
}

/** 只保留用户消息的树：每条用户消息挂到最近的用户消息祖先下。 */
export function userMessageTree(entries: readonly SessionEntry[]): TreeNode[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const entry of entries) {
    const text = userText(entry);
    if (text === undefined) continue;
    const node: TreeNode = { entry, text, children: [] };
    nodes.set(entry.id, node);
    let parentId = entry.parentId;
    let parent: TreeNode | undefined;
    const seen = new Set<string>();
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      parent = nodes.get(parentId);
      if (parent !== undefined) break;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    (parent?.children ?? roots).push(node);
  }
  return roots;
}

/**
 * 树 → 列表项：分叉处子分支缩进一级，单链保持同级；`●` 在当前分支上、`○` 不在。
 * value 是用户消息条目的 id。
 */
export function treeItems(
  entries: readonly SessionEntry[],
  activeIds: ReadonlySet<string>,
  now: number,
): SelectItem[] {
  const items: SelectItem[] = [];
  const visit = (list: readonly TreeNode[], depth: number): void => {
    const fork = list.length > 1;
    for (const node of list) {
      const level = fork ? depth + 1 : depth;
      const mark = activeIds.has(node.entry.id) ? "● " : "○ ";
      const text = node.text.length > 60 ? `${node.text.slice(0, 59)}…` : node.text;
      items.push({
        value: node.entry.id,
        label: `${"  ".repeat(level)}${mark}${text === "" ? "（空）" : text}`,
        description: relativeTime(node.entry.timestamp, now),
      });
      visit(node.children, level);
    }
  };
  const roots = userMessageTree(entries);
  visit(roots, roots.length > 1 ? -1 : 0);
  return items;
}
