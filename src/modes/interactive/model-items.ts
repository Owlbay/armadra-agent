/**
 * 模型选择器的列表项（`/model`、启动选择器、`/config` 的模型项共用）。
 *
 * - 缺省视图「已配置」：只列有 key、OAuth 已登录或本地的供应商；设置了 `models.enabled` 时只列清单内的
 *   （`provider/*` 整个供应商）。「全部」视图（`/model` 里 Tab）另列没配置的供应商，组标题标「未配置 key」。
 * - 当前会话的模型不在视图里时置顶一行，组标题「当前」。
 * - 多渠道供应商每个模型一行（首选渠道），说明里列出其它渠道；`channels`（筛选文本含 `@`）时再列出
 *   `model@渠道` 行。清单里逐字写了 `provider/model@渠道` 的渠道行总是列出。
 * - 模型表为空的供应商（ChatGPT 订阅，未缓存发现结果）给一行提示（value 以 `HINT_PREFIX` 开头，不是模型）。
 *
 * 先 `loadModelCatalog`（解析 key，异步）再 `catalogItems`（同步）：选择器切视图、改清单时不必重查 key。
 */

import type { Model, ProviderData, ProviderRegistryApi } from "../../ai/types.js";
import {
  accessReady,
  enabledMatch,
  providerAccess,
  type ProviderAccess,
} from "../../ai/providers/model-visibility.js";
import { CHATGPT_PROVIDER_ID } from "../../auth/chatgpt/presets.js";
import { msg } from "../../i18n/index.js";
import type { SelectItem } from "../../tui.js";

/** 提示行的 value 前缀（`ama:hint:<供应商>`）；选中时不是模型。 */
export const HINT_PREFIX = "ama:hint:";

export function isHintValue(value: string): boolean {
  return value.startsWith(HINT_PREFIX);
}

export interface CatalogProvider {
  provider: ProviderData;
  access: ProviderAccess;
}

export interface ModelCatalog {
  providers: readonly CatalogProvider[];
}

export interface ModelItemOptions {
  /** `configured`（缺省）或 `all`。 */
  view?: "configured" | "all";
  /** `models.enabled`；undefined / 空表示不限。 */
  enabled?: readonly string[] | undefined;
  /** 当前模型 `provider/model[@channel]`。 */
  current?: string | undefined;
  /** 列出 `model@渠道` 行。 */
  channels?: boolean;
  /** 列提示行（缺省 true；启动选择器与 `/config` 关掉）。 */
  hints?: boolean;
}

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

export async function loadModelCatalog(registry: ProviderRegistryApi): Promise<ModelCatalog> {
  const providers: CatalogProvider[] = [];
  for (const provider of registry.list())
    providers.push({ provider, access: await providerAccess(registry, provider) });
  return { providers };
}

export function accessLabel(access: ProviderAccess): string {
  const m = msg().panels.model;
  return access === "none" ? m.noKey : m[access];
}

/** 模型的其它渠道（首选渠道之外）。 */
function otherChannels(model: Model): string[] {
  return (model.channels ?? []).filter((c) => c !== "" && c !== model.channel);
}

function row(model: Model, group: string, channel?: string): SelectItem {
  const suffix = channel === undefined ? "" : `@${channel}`;
  const item: SelectItem = {
    value: `${model.provider}/${model.id}${suffix}`,
    label: `${model.id}${suffix}`,
    group,
  };
  const others = channel === undefined ? otherChannels(model) : [];
  const parts = [
    modelDescription(model),
    others.length > 0
      ? msg().panels.model.otherChannels(others.map((c) => `@${c}`).join(" "))
      : undefined,
  ].filter((x) => x !== undefined);
  if (parts.length > 0) item.description = parts.join(" · ");
  return item;
}

function hintRow(entry: CatalogProvider, group: string): SelectItem | undefined {
  const { provider, access } = entry;
  if (provider.models.length > 0 || !provider.requiresApiKey) return undefined;
  const m = msg().panels.model;
  if (access === "key" || access === "oauth")
    return { value: `${HINT_PREFIX}${provider.id}`, label: m.discoverHint(provider.id), group };
  if (provider.id === CHATGPT_PROVIDER_ID)
    return { value: `${HINT_PREFIX}${provider.id}`, label: m.loginHint(provider.id), group };
  return undefined;
}

/** 目录 → 列表项（规则见文件头）。 */
export function catalogItems(catalog: ModelCatalog, options: ModelItemOptions = {}): SelectItem[] {
  const all = options.view === "all";
  const list =
    options.enabled !== undefined && options.enabled.length > 0 ? options.enabled : undefined;
  const ready: SelectItem[] = [];
  const rest: SelectItem[] = [];
  for (const entry of catalog.providers) {
    const { provider, access } = entry;
    const isReady = accessReady(access);
    const group = `${provider.id} · ${accessLabel(access)}`;
    const items: SelectItem[] = [];
    const listedProvider = list?.includes(`${provider.id}/*`) === true;
    for (const model of provider.models) {
      const main = row(model, group);
      const listed = list !== undefined && enabledMatch(list, main.value) !== undefined;
      const shown = all || (list !== undefined ? listed : isReady);
      if (shown) {
        if (all && listed) main.badge = msg().panels.model.listed;
        if (all && listed) main.badgeColor = "dim";
        items.push(main);
      }
      for (const channel of otherChannels(model)) {
        const extra = row(model, group, channel);
        const exact = list?.includes(extra.value) === true;
        if (exact || (shown && options.channels === true)) items.push(extra);
      }
    }
    const hint = options.hints === false ? undefined : hintRow(entry, group);
    if (hint !== undefined && (all || (list !== undefined ? listedProvider : isReady)))
      items.push(hint);
    (isReady ? ready : rest).push(...items);
  }
  return pinCurrent(catalog, [...ready, ...rest], options.current);
}

/** 当前模型不在列表里时置顶一行。 */
function pinCurrent(
  catalog: ModelCatalog,
  items: SelectItem[],
  current: string | undefined,
): SelectItem[] {
  if (current === undefined || current === "" || items.some((i) => i.value === current))
    return items;
  const slash = current.indexOf("/");
  const at = current.lastIndexOf("@");
  const base = at > slash ? current.slice(0, at) : current;
  const model = catalog.providers
    .find((p) => p.provider.id === current.slice(0, slash))
    ?.provider.models.find((m) => `${m.provider}/${m.id}` === base);
  const item: SelectItem = { value: current, label: current, group: msg().panels.model.current };
  const description = model === undefined ? undefined : modelDescription(model);
  if (description !== undefined) item.description = description;
  return [item, ...items];
}

/** 一步到位：解析 key 再生成列表项。 */
export async function modelItems(
  registry: ProviderRegistryApi,
  options: ModelItemOptions = {},
): Promise<SelectItem[]> {
  return catalogItems(await loadModelCatalog(registry), options);
}
