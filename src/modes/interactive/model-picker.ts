/**
 * 交互模式的 `/model` 选择器：居中覆盖层，列表项见 model-items.ts。
 *
 * - `Tab` 在「已配置 / 全部」两个视图间切换（过滤文本保留）；全部视图里没配置的供应商标「未配置 key」，
 *   选中它的模型不切换，选择器底部提示 `ama auth set` / `ama providers add`；
 * - `Space` 把高亮的模型加入 / 移出用户级 `models.enabled`（经 config/edit.ts 写回）；只经 `provider/*`
 *   列入的不能单独移出，提示改用 `ama models disable`；
 * - 筛选文本含 `@` 时列出各模型的 `@渠道` 行；
 * - 已在用清单时，从全部视图选中清单外的模型会先把它加入清单再切换；
 * - 提示行（模型表为空的供应商）选中时只在底部显示命令。
 */

import type { ProviderRegistryApi } from "../../ai/types.js";
import {
  accessReady,
  addEnabled,
  enabledList,
  enabledMatch,
  removeEnabled,
} from "../../ai/providers/model-visibility.js";
import type { ModeContext } from "../../cli/deps.js";
import type { Runtime } from "../../cli/runtime.js";
import { setConfigValue } from "../../config/edit.js";
import { msg } from "../../i18n/index.js";
import {
  Box,
  SelectList,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type SelectItem,
} from "../../tui.js";
import { layerInputFor } from "./config-ui.js";
import { catalogItems, isHintValue, loadModelCatalog, type ModelCatalog } from "./model-items.js";
import type { PickerHost } from "./pickers.js";

export interface ModelPickerOptions {
  title: string;
  providers: ProviderRegistryApi;
  /** 当前模型 `provider/model[@channel]`。 */
  current?: string | undefined;
  /** 打开时的 `models.enabled`。 */
  enabled?: readonly string[] | undefined;
  /** 写回用户级 `models.enabled`（undefined 删除该键）；抛错时错误显示在选择器底部。 */
  saveEnabled(next: string[] | undefined): void;
}

type View = "configured" | "all";

/** 选择器本体（可单独测试）：`done` 收到选中的模型引用或 undefined（取消）。 */
export class ModelPickerView implements Component, Focusable {
  private view: View = "configured";
  private enabled: readonly string[] | undefined;
  private notice: { text: string; level: "info" | "warning" | "error" } | undefined;
  private channels = false;
  readonly list: SelectList;

  constructor(
    private readonly host: PickerHost,
    private readonly catalog: ModelCatalog,
    private readonly options: ModelPickerOptions,
    private readonly done: (ref: string | undefined) => void,
  ) {
    this.enabled = enabledList(options.enabled);
    this.list = new SelectList([], {
      theme: host.theme,
      maxVisible: 12,
      filterable: true,
      showCount: true,
      ...(host.keybindings !== undefined ? { keybindings: host.keybindings } : {}),
      ...(options.current !== undefined ? { currentValue: options.current } : {}),
      emptyText: msg().panels.model.emptyConfigured,
      onSelect: (item) => this.select(item),
      onCancel: () => this.done(undefined),
    });
    this.rebuild();
    if (options.current !== undefined) this.list.selectValue(options.current);
  }

  get focused(): boolean {
    return this.list.focused;
  }

  set focused(value: boolean) {
    this.list.focused = value;
  }

  get currentView(): View {
    return this.view;
  }

  private rebuild(): void {
    const m = msg().panels.model;
    this.list.setFooter(this.view === "all" ? m.footerAll : m.footerConfigured);
    this.list.setItems(
      catalogItems(this.catalog, {
        view: this.view,
        enabled: this.enabled,
        current: this.options.current,
        channels: this.channels,
      }),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "tab")) {
      this.view = this.view === "all" ? "configured" : "all";
      this.notice = undefined;
      this.rebuild();
      return;
    }
    if (data === " ") {
      this.toggle();
      return;
    }
    this.list.handleInput(data);
    const channels = this.list.getFilter().includes("@");
    if (channels !== this.channels) {
      this.channels = channels;
      this.rebuild();
    }
  }

  private providerOf(value: string) {
    const id = value.slice(0, value.indexOf("/"));
    return this.catalog.providers.find((p) => p.provider.id === id);
  }

  private save(next: string[] | undefined): boolean {
    try {
      this.options.saveEnabled(next);
      this.enabled = next;
      return true;
    } catch (error) {
      this.notice = {
        text: error instanceof Error ? error.message : String(error),
        level: "error",
      };
      return false;
    }
  }

  private toggle(): void {
    const item = this.list.getSelected();
    if (item === undefined || isHintValue(item.value)) return;
    const m = msg().panels.model;
    const ref = item.value;
    const match = this.enabled === undefined ? undefined : enabledMatch(this.enabled, ref);
    if (match?.kind === "wildcard") {
      this.notice = { text: m.wildcard(ref, match.pattern), level: "warning" };
    } else if (match !== undefined) {
      if (this.save(removeEnabled(this.enabled, [ref])))
        this.notice = { text: m.removed(ref), level: "info" };
    } else {
      const first = this.enabled === undefined;
      if (this.save(addEnabled(this.enabled, [ref])))
        this.notice = { text: first ? m.addedFirst(ref) : m.added(ref), level: "info" };
    }
    this.rebuild();
  }

  private select(item: SelectItem): void {
    const m = msg().panels.model;
    const id = item.value.slice(0, item.value.indexOf("/"));
    if (isHintValue(item.value)) {
      this.notice = { text: item.label, level: "info" };
      return;
    }
    const entry = this.providerOf(item.value);
    if (item.value !== this.options.current && entry !== undefined && !accessReady(entry.access)) {
      const text = entry.access === "needsLogin" ? m.needsLoginHint(id) : m.noKeyHint(id);
      this.notice = { text, level: "warning" };
      return;
    }
    if (
      this.enabled !== undefined &&
      item.value !== this.options.current &&
      enabledMatch(this.enabled, item.value) === undefined &&
      !this.save(addEnabled(this.enabled, [item.value]))
    )
      return;
    this.done(item.value);
  }

  render(width: number): string[] {
    const lines = this.list.render(width);
    if (this.notice === undefined) return lines;
    const theme = this.host.theme;
    const color = this.notice.level === "info" ? "dim" : this.notice.level;
    return [...lines, ...wrapTextWithAnsi(theme.fg(color, this.notice.text), width)];
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

/** 打开 `/model` 选择器；返回选中的模型引用，取消返回 undefined。 */
export async function openModelPicker(
  host: PickerHost,
  options: ModelPickerOptions,
): Promise<string | undefined> {
  const catalog = await loadModelCatalog(options.providers);
  return new Promise((resolve) => {
    let handle: ReturnType<PickerHost["showOverlay"]> | undefined;
    const view = new ModelPickerView(host, catalog, options, (ref) => {
      handle?.hide();
      resolve(ref);
    });
    const width = Math.max(20, Math.min(host.columns() - 2, 72));
    handle = host.showOverlay(new Box(view, { title: options.title, theme: host.theme }), {
      anchor: "center",
      width,
    });
  });
}

/** 交互模式装配：清单读 `runtime.config`，写用户级 config.json 并换上新配置。 */
export function modelPickerFor(
  host: PickerHost,
  runtime: Runtime,
  context: ModeContext,
): (providers: ProviderRegistryApi, current: string | undefined) => Promise<string | undefined> {
  return (providers, current) =>
    openModelPicker(host, {
      title: msg().interactive.commands.modelTitle,
      providers,
      current,
      enabled: runtime.config.models?.enabled,
      saveEnabled: (next) => {
        const result = setConfigValue({
          ...layerInputFor(runtime, context),
          scope: "user",
          key: "models.enabled",
          value: next,
        });
        runtime.replaceConfig?.(result.snapshot.config);
      },
    });
}
