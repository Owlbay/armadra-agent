/**
 * ChatGPT 后端的只读查询（[W6-O]）：模型列表（`ama models discover chatgpt`）与 codex 的 `wham/usage`。
 *
 * - SIWC：`GET {base}/models`，只留 `visibility === "list"`（没有该字段的也留）；条目若带下述元数据字段同样取；
 * - codex：`GET {base}/models?client_version=<Codex CLI 版本>`（`codexClientVersion()`；后端按每个模型的
 *   `minimal_client_version` 过滤，发 ama 自己的版本号会一个都拿不到），`models[].slug`（同样按 visibility 筛），
 *   另取 `context_window`、`input_modalities`、`supported_reasoning_levels` 作元数据（后端给了就优先于 models.dev，
 *   见 discovered-cache.ts；`max_context_window` 是可调上限而非生效值、`auto_compact_token_limit` 没有对应的模型字段，
 *   都不取）；`GET https://chatgpt.com/backend-api/wham/usage`（由 codex base 推出），私有格式，解析失败返回 undefined。
 * 请求带 Bearer；codex 另带 `ChatGPT-Account-ID` 与 `originator`。
 */

import { parseUsagePayload, type QuotaSnapshot } from "../../ai/apis/chatgpt-rate-limits.js";
import type { ChatGptFlavor } from "../../config/types-w6.js";
import type { FetchLike } from "../oauth/token-client.js";
import { DEFAULT_CODEX_CLIENT_VERSION, DEFAULT_ORIGINATOR } from "./presets.js";

export const BACKEND_TIMEOUT_MS = 15_000;

export interface BackendAuth {
  flavor: ChatGptFlavor;
  accessToken: string;
  accountId?: string | undefined;
  originator?: string | undefined;
  /** codex 模型列表的 `client_version`，缺省 `DEFAULT_CODEX_CLIENT_VERSION`。 */
  clientVersion?: string | undefined;
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
  /** 以下是后端给的元数据（codex 后端给；SIWC 条目带了也取）。 */
  contextWindow?: number;
  input?: ("text" | "image")[];
  /** 支持的推理强度（`none` / `minimal` / `low` / `medium` / `high` / `xhigh` …）。 */
  reasoningLevels?: string[];
}

function listed(item: Record<string, unknown>): boolean {
  const visibility = item["visibility"];
  return visibility === undefined || visibility === "list";
}

/** 模型条目里的元数据；字段缺失或形状不对就不填。 */
function backendMetadata(item: Record<string, unknown>): Omit<DiscoveredModel, "id" | "name"> {
  const out: Omit<DiscoveredModel, "id" | "name"> = {};
  const window = item["context_window"];
  if (typeof window === "number" && Number.isInteger(window) && window > 0)
    out.contextWindow = window;
  const modalities = item["input_modalities"];
  if (Array.isArray(modalities)) {
    const input = (["text", "image"] as const).filter((x) => modalities.includes(x));
    if (input.includes("text")) out.input = input;
  }
  const levels = item["supported_reasoning_levels"];
  if (Array.isArray(levels)) {
    const efforts = levels
      .map((level: unknown) =>
        typeof level === "string"
          ? level
          : typeof level === "object" && level !== null
            ? (level as Record<string, unknown>)["effort"]
            : undefined,
      )
      .filter((x): x is string => typeof x === "string" && x !== "");
    if (efforts.length > 0) out.reasoningLevels = [...new Set(efforts)];
  }
  return out;
}

export async function listChatGptModels(
  fetchFn: FetchLike,
  baseUrl: string,
  auth: BackendAuth,
): Promise<DiscoveredModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const version = auth.clientVersion ?? DEFAULT_CODEX_CLIENT_VERSION;
  const url =
    auth.flavor === "codex"
      ? `${base}/models?client_version=${encodeURIComponent(version)}`
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
    out.push({
      id,
      ...(typeof name === "string" && name !== "" ? { name } : {}),
      ...backendMetadata(item),
    });
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
