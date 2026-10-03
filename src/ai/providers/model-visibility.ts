/**
 * 模型选择器的可见性规则（`/model`、启动选择器、`/config` 的模型项、`ama models list --enabled` 共用）。
 *
 * - 供应商的可用状态：本地（`requiresApiKey: false`）、有 key、OAuth 已登录、OAuth 需重新登录、没配置；
 *   前三种算「已配置」，缺省只显示它们的模型。
 * - `models.enabled`（用户级）：`provider/model[@channel]` 或 `provider/*`；设置后只显示清单内的模型。
 *   清单为空等同不设（写回时删掉这个键）。
 */

import { liveToken } from "../../auth/oauth/live.js";
import type { ProviderData, ProviderRegistryApi } from "../types.js";

export type ProviderAccess = "local" | "key" | "oauth" | "needsLogin" | "none";

/** 解析 key 判断供应商的可用状态（OAuth 条目会按需刷新，与发请求前相同）。 */
export async function providerAccess(
  registry: ProviderRegistryApi,
  provider: ProviderData,
): Promise<ProviderAccess> {
  if (!provider.requiresApiKey) return "local";
  const key = await registry
    .resolveApiKey(provider.id)
    .catch(() => ({ apiKey: undefined, source: "none" as const }));
  if (key.apiKey === undefined) return "none";
  if (key.source !== "oauth") return "key";
  return liveToken(key.apiKey)?.needsLogin === true ? "needsLogin" : "oauth";
}

export function accessReady(access: ProviderAccess): boolean {
  return access === "local" || access === "key" || access === "oauth";
}

/** `provider/model@channel` → 三段（模型 id 里可以有 `/`）。 */
export function splitEnabledRef(
  ref: string,
): { provider: string; model: string; channel?: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  const provider = ref.slice(0, slash);
  const rest = ref.slice(slash + 1);
  const at = rest.lastIndexOf("@");
  if (at > 0) return { provider, model: rest.slice(0, at), channel: rest.slice(at + 1) };
  return { provider, model: rest };
}

/**
 * 清单是否包含该行：`exact` 是逐字列出（`provider/model`，渠道行要 `provider/model@channel`），
 * `wildcard` 只经 `provider/*` 匹配上。
 */
export function enabledMatch(
  list: readonly string[],
  ref: string,
): { kind: "exact" | "wildcard"; pattern: string } | undefined {
  if (list.includes(ref)) return { kind: "exact", pattern: ref };
  const parts = splitEnabledRef(ref);
  if (parts === undefined) return undefined;
  const wildcard = `${parts.provider}/*`;
  return list.includes(wildcard) ? { kind: "wildcard", pattern: wildcard } : undefined;
}

/** 追加（去重、保持顺序）。 */
export function addEnabled(list: readonly string[] | undefined, refs: readonly string[]): string[] {
  const out = [...(list ?? [])];
  for (const ref of refs) if (!out.includes(ref)) out.push(ref);
  return out;
}

/** 移出；移空返回 undefined（删掉键，恢复「显示全部已配置」）。 */
export function removeEnabled(
  list: readonly string[] | undefined,
  refs: readonly string[],
): string[] | undefined {
  const out = (list ?? []).filter((ref) => !refs.includes(ref));
  return out.length > 0 ? out : undefined;
}

/** 配置里的清单：非数组或空数组视为未设置。 */
export function enabledList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((x): x is string => typeof x === "string");
  return list.length > 0 ? list : undefined;
}
