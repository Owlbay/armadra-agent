/**
 * 回滚列表（rewind-plan §4）：居中覆盖层 + `SelectList`。[RW-C]
 *
 * - 活动路径上的回滚点，最旧在上、最近在下，缺省选中最后一条；标签是消息首行，说明是相对时间。
 * - 右侧徽标：没有检查点的行一律「仅对话」；有检查点的只给高亮行算——对它做一次代码 dry-run，
 *   结果按 entryId 缓存，算好后异步刷新：`N 文件 +x −y` / `无代码改动`，计算中 `…`，失败 `—`。
 */

import type { RewindPoint, RewindResult } from "../../checkpoints/types.js";
import { Box, SelectList, type SelectItem } from "../../tui.js";
import { PICKER_FOOTER, type PickerHost } from "./pickers.js";
import { badgeText, hasCodeChanges, oneLine, rewindErrorText } from "./rewind-text.js";
import { relativeTime } from "./startup-ui.js";

export type PreviewState =
  | { state: "pending" }
  | { state: "done"; result: RewindResult }
  | { state: "error"; message: string };

/** 代码 dry-run 的缓存：每个回滚点最多算一次。 */
export class PreviewCache {
  private readonly states = new Map<string, PreviewState>();
  private readonly running = new Map<string, Promise<PreviewState>>();

  constructor(private readonly load: (entryId: string) => Promise<RewindResult>) {}

  get(entryId: string): PreviewState | undefined {
    return this.states.get(entryId);
  }

  ensure(entryId: string): Promise<PreviewState> {
    const known = this.states.get(entryId);
    if (known !== undefined && known.state !== "pending") return Promise.resolve(known);
    const running = this.running.get(entryId);
    if (running !== undefined) return running;
    this.states.set(entryId, { state: "pending" });
    const promise = this.load(entryId).then(
      (result): PreviewState => ({ state: "done", result }),
      (error: unknown): PreviewState => ({ state: "error", message: rewindErrorText(error) }),
    );
    const settled = promise.then((state) => {
      this.states.set(entryId, state);
      this.running.delete(entryId);
      return state;
    });
    this.running.set(entryId, settled);
    return settled;
  }
}

/** 列表项：value = 用户消息条目 id。 */
export function rewindListItems(
  points: readonly RewindPoint[],
  cache: PreviewCache,
  highlighted: string | undefined,
  now: number,
  ascii = false,
): SelectItem[] {
  return points.map((point) => {
    const text = oneLine(point.text, 60, ascii ? "..." : "…");
    const item: SelectItem = {
      value: point.entryId,
      label: text === "" ? "（空）" : text,
      description: relativeTime(new Date(point.timestamp).toISOString(), now),
    };
    if (!point.hasCheckpoint) {
      item.badge = "仅对话";
      item.badgeColor = "dim";
    } else if (point.entryId === highlighted) {
      const state = cache.get(point.entryId);
      if (state === undefined || state.state === "pending") {
        item.badge = ascii ? "..." : "…";
        item.badgeColor = "dim";
      } else if (state.state === "error") {
        item.badge = ascii ? "-" : "—";
        item.badgeColor = "dim";
      } else {
        const code = state.result.code;
        item.badge = code === undefined ? "无代码改动" : badgeText(code, ascii);
        item.badgeColor = hasCodeChanges(code) ? "accent" : "dim";
      }
    }
    return item;
  });
}

export interface RewindListHost extends PickerHost {
  render(): void;
  now(): number;
}

/** 打开回滚列表；Enter 返回选中的回滚点，Esc 返回 undefined。 */
export function openRewindList(
  host: RewindListHost,
  points: readonly RewindPoint[],
  cache: PreviewCache,
): Promise<RewindPoint | undefined> {
  return new Promise((resolve) => {
    const ascii = host.theme.glyphs.ascii;
    let highlighted = points.at(-1)?.entryId;
    let refreshing = false;
    let closed = false;
    const items = (): SelectItem[] =>
      rewindListItems(points, cache, highlighted, host.now(), ascii);
    const refresh = (): void => {
      if (refreshing || closed) return;
      refreshing = true;
      list.setItems(items());
      refreshing = false;
      host.render();
    };
    const close = (point: RewindPoint | undefined): void => {
      closed = true;
      handle.hide();
      resolve(point);
    };
    const highlight = (entryId: string | undefined): void => {
      highlighted = entryId;
      const point = points.find((p) => p.entryId === entryId);
      if (point?.hasCheckpoint === true) void cache.ensure(point.entryId).then(refresh);
      refresh();
    };
    const list = new SelectList(items(), {
      theme: host.theme,
      maxVisible: 10,
      filterable: points.length > 8,
      ...(host.keybindings !== undefined ? { keybindings: host.keybindings } : {}),
      footer: PICKER_FOOTER.replace("↑↓", host.theme.glyphs.arrowUp + host.theme.glyphs.arrowDown),
      onSelect: (item) => close(points.find((p) => p.entryId === item.value)),
      onCancel: () => close(undefined),
      onSelectionChange: (item) => {
        if (!refreshing && item?.value !== highlighted) highlight(item?.value);
      },
    });
    if (highlighted !== undefined) list.selectValue(highlighted);
    const width = Math.max(20, Math.min(host.columns() - 2, 72));
    const handle = host.showOverlay(
      new Box(list, { title: "回滚到哪条消息之前", theme: host.theme }),
      {
        anchor: "center",
        width,
      },
    );
    highlight(highlighted);
  });
}
