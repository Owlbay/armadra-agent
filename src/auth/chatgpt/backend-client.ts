/**
 * ChatGPT 后端的只读查询（[W6-O]）：模型列表（`ama models discover chatgpt`）与 codex 的 `wham/usage`。
 *
 * - SIWC：`GET {base}/models`，只留 `visibility === "list"`（没有该字段的也留）；
 * - codex：`GET {base}/models?client_version=<ama 版本>`，`models[].slug`（同样按 visibility 筛）；
 *   `GET https://chatgpt.com/backend-api/wham/usage`（由 codex base 推出），私有格式，解析失败返回 undefined。
 * 只取 slug 与显示名，上下文窗口不猜。请求带 Bearer；codex 另带 `ChatGPT-Account-ID` 与 `originator`。
 */

import { parseUsagePayload, type QuotaSnapshot } from "../../ai/apis/chatgpt-rate-limits.js";
import type { ChatGptFlavor } from "../../config/types-w6.js";
import { AMA_VERSION } from "../../version.js";
import type { FetchLike } from "../oauth/token-client.js";
import { DEFAULT_ORIGINATOR } from "./presets.js";

export const BACKEND_TIMEOUT_MS = 15_000;

export interface BackendAuth {
  flavor: ChatGptFlavor;
  accessToken: string;
  accountId?: string | undefined;
  originator?: string | undefined;
}

function headers(auth: BackendAuth): Record<string, string> {
  const out: Record<string, string> = {
    authorization: `Bearer ${auth.accessToken}`,
    accept: "application/json",
  };
  if (auth.flavor === "codex") {
    if (auth.accountId !== undefined) out["ChatGPT-Account-ID"] = auth.accountId;
    out["originator"] = auth.originator ?? DEFAULT_ORIGINATOR;
  }
  return out;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
}

function listed(item: Record<string, unknown>): boolean {
  const visibility = item["visibility"];
  return visibility === undefined || visibility === "list";
}

export async function listChatGptModels(
  fetchFn: FetchLike,
  baseUrl: string,
  auth: BackendAuth,
): Promise<DiscoveredModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url =
    auth.flavor === "codex"
      ? `${base}/models?client_version=${encodeURIComponent(AMA_VERSION)}`
      : `${base}/models`;
  const response = await fetchFn(url, {
    headers: headers(auth),
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} listing models from ${url}`);
  const body = (await response.json()) as { data?: unknown; models?: unknown };
  const items = (
    Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : []
  )
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .filter(listed);
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = item["slug"] ?? item["id"];
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    const name = item["display_name"];
    out.push(typeof name === "string" && name !== "" ? { id, name } : { id });
  }
  return out;
}

export function usageUrl(codexBaseUrl: string): string {
  const base = codexBaseUrl.replace(/\/+$/, "").replace(/\/codex$/, "");
  return `${base}/wham/usage`;
}

/** codex 的配额；任何失败返回 undefined。 */
export async function fetchCodexUsage(
  fetchFn: FetchLike,
  codexBaseUrl: string,
  auth: BackendAuth,
  timeoutMs = 5_000,
): Promise<QuotaSnapshot | undefined> {
  try {
    const response = await fetchFn(usageUrl(codexBaseUrl), {
      headers: headers(auth),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return parseUsagePayload(await response.json());
  } catch {
    return undefined;
  }
}
