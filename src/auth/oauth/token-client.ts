/**
 * OAuth 端点的 HTTP 调用（token 交换 / 刷新 / 撤销 / discovery）。[W6-O]
 *
 * 日志红线（docs/history/wave6-plan.md §4.3）：错误只带 HTTP 状态与 `error` 码（截断到 64 字符），从不带响应
 * 原文、请求参数、code 或任何 token。
 */

import { AmaError } from "../../errors.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const OAUTH_TIMEOUT_MS = 30_000;

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** 秒。 */
  expiresIn?: number;
  scope?: string;
  clientId?: string;
}

/** OAuth 端点返回非 2xx：`status` 与 `error` 码（不含描述原文）。 */
export class OAuthHttpError extends AmaError {
  readonly status: number;
  readonly error: string | undefined;

  constructor(status: number, error: string | undefined, what: string) {
    super("oauth_http", `${what} failed: HTTP ${status}${error ? ` ${error}` : ""}`, {
      detail: { status, error },
    });
    this.status = status;
    this.error = error;
  }
}

/** 响应体里的错误码：`error`（字符串或 `{code|type}`）、`code`、`error_code`。 */
export function oauthErrorCode(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const error = value["error"];
    const nested =
      typeof error === "object" && error !== null
        ? ((error as Record<string, unknown>)["code"] ?? (error as Record<string, unknown>)["type"])
        : error;
    const code = nested ?? value["code"] ?? value["error_code"];
    return typeof code === "string" && code !== "" ? code.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

function signalOf(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export async function postOAuth(
  fetchFn: FetchLike,
  url: string,
  params: Record<string, string>,
  options: { encoding: "form" | "json"; what: string; signal?: AbortSignal | undefined },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers:
        options.encoding === "form"
          ? { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }
          : { "content-type": "application/json", accept: "application/json" },
      body:
        options.encoding === "form"
          ? new URLSearchParams(params).toString()
          : JSON.stringify(params),
      signal: signalOf(options.signal),
    });
  } catch (error) {
    throw new AmaError("oauth_network", `${options.what} failed: ${(error as Error).name}`, {
      cause: undefined,
    });
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new OAuthHttpError(response.status, oauthErrorCode(text), options.what);
  if (text.trim() === "") return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  } catch {
    // 落到下面
  }
  throw new AmaError("oauth_bad_response", `${options.what}: response is not JSON`);
}

export function parseTokenResponse(value: Record<string, unknown>, what: string): TokenResponse {
  const access = value["access_token"];
  if (typeof access !== "string" || access === "")
    throw new AmaError("oauth_bad_response", `${what}: no access_token`);
  const out: TokenResponse = { accessToken: access };
  const str = (key: string): string | undefined =>
    typeof value[key] === "string" && value[key] !== "" ? (value[key] as string) : undefined;
  const refresh = str("refresh_token");
  if (refresh !== undefined) out.refreshToken = refresh;
  const id = str("id_token");
  if (id !== undefined) out.idToken = id;
  const scope = str("scope");
  if (scope !== undefined) out.scope = scope;
  const clientId = str("client_id");
  if (clientId !== undefined) out.clientId = clientId;
  const expires = value["expires_in"];
  const seconds = typeof expires === "string" ? Number(expires) : expires;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0)
    out.expiresIn = seconds;
  return out;
}

export async function getJson(
  fetchFn: FetchLike,
  url: string,
  what: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal: signalOf(signal),
    });
  } catch (error) {
    throw new AmaError("oauth_network", `${what} failed: ${(error as Error).name}`);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new OAuthHttpError(response.status, oauthErrorCode(text), what);
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  } catch {
    // 落到下面
  }
  throw new AmaError("oauth_bad_response", `${what}: response is not JSON`);
}
