/**
 * OAuth access token 的取用与刷新（docs/history/wave6-plan.md §4.3、D15）。[W6-O]
 *
 * - 触发：`expiresAt − now < 5 min`，或协议层 401 后 `force`；
 * - 进程内：同一 (auth.json, 供应商) 共用一个刷新 Promise；
 * - 跨进程：`withRefreshLock` 取锁后**重读**文件——`refreshToken` 已变（别的进程刷过）且 token 仍新鲜就直接用；
 *   否则调 token 端点（SIWC 表单 + `resource`；codex JSON），原子写回后释放；
 * - 永久失败（`refresh_token_expired` / `_reused` / `_invalidated` / `invalid_grant` / `invalid_refresh_token` /
 *   `token_expired` / `invalid_client` / 401）：条目标 `needsLogin: true`（不删 token），抛 `auth_expired`；
 *   暂时失败（网络、5xx、429）退避重试 2 次，仍失败抛原错误。
 */

import type { ChatGptAuthConfig, OAuthAuthEntry } from "../../config/types-w6.js";
import { AmaError } from "../../errors.js";
import { resolveChatGptPreset } from "../chatgpt/presets.js";
import { OAuthHttpError, parseTokenResponse, postOAuth, type FetchLike } from "./token-client.js";
import { readOAuthEntry, withRefreshLock, writeOAuthEntry } from "./token-store.js";

export const REFRESH_MARGIN_MS = 5 * 60_000;
export const RETRY_DELAYS_MS = [500, 1500] as const;

const PERMANENT = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "invalid_client",
]);

export interface RefreshDeps {
  fetch?: FetchLike | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  config?: ChatGptAuthConfig | undefined;
  /** 锁等待（测试缩短）。 */
  lockWaitMs?: number | undefined;
}

export function authExpiredError(provider: string): AmaError {
  return new AmaError(
    "auth_expired",
    `auth_expired: ${provider} login expired; run \`ama auth login ${provider}\``,
    { detail: { provider } },
  );
}

export function isFresh(entry: OAuthAuthEntry, now: number): boolean {
  return entry.expiresAt - now > REFRESH_MARGIN_MS;
}

const inflight = new Map<string, Promise<OAuthAuthEntry>>();

async function callTokenEndpoint(
  entry: OAuthAuthEntry,
  deps: RefreshDeps,
): Promise<Record<string, unknown>> {
  const preset = resolveChatGptPreset(entry.flavor, { entry, env: deps.env, config: deps.config });
  // token 属于签发它的 issuer：条目里记的优先
  const issuer = (entry.issuer ?? preset.issuer).replace(/\/+$/, "");
  const tokenUrl =
    entry.flavor === "siwc" ? `${issuer}/api/accounts/oauth/token` : `${issuer}/oauth/token`;
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: entry.clientId ?? preset.clientId,
    refresh_token: entry.refreshToken,
  };
  if (preset.resource !== undefined) params["resource"] = preset.resource;
  const fetchFn = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await postOAuth(fetchFn, tokenUrl, params, {
        encoding: preset.refreshEncoding,
        what: "token refresh",
      });
    } catch (error) {
      const permanent =
        error instanceof OAuthHttpError &&
        (error.status === 401 || (error.error !== undefined && PERMANENT.has(error.error)));
      if (permanent) throw error;
      const temporary =
        !(error instanceof OAuthHttpError) || error.status >= 500 || error.status === 429;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!temporary || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

async function refreshLocked(
  authFile: string,
  provider: string,
  seen: OAuthAuthEntry,
  force: boolean,
  deps: RefreshDeps,
): Promise<OAuthAuthEntry> {
  const now = deps.now ?? Date.now;
  return withRefreshLock(
    authFile,
    async () => {
      const current = readOAuthEntry(authFile, provider);
      if (current === undefined) throw authExpiredError(provider);
      if (current.needsLogin === true) throw authExpiredError(provider);
      // 别的进程已经刷过：直接用
      const rotated =
        current.refreshToken !== seen.refreshToken || current.accessToken !== seen.accessToken;
      if ((rotated || !force) && isFresh(current, now())) return current;
      let raw: Record<string, unknown>;
      try {
        raw = await callTokenEndpoint(current, deps);
      } catch (error) {
        if (
          error instanceof OAuthHttpError &&
          (error.status === 401 || (error.error !== undefined && PERMANENT.has(error.error)))
        ) {
          writeOAuthEntry(authFile, provider, { ...current, needsLogin: true });
          throw authExpiredError(provider);
        }
        throw error;
      }
      const token = parseTokenResponse(raw, "token refresh");
      const at = now();
      const next: OAuthAuthEntry = {
        ...current,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? current.refreshToken,
        expiresAt: at + (token.expiresIn ?? 3600) * 1000,
        lastRefresh: new Date(at).toISOString(),
      };
      if (token.idToken !== undefined) next.idToken = token.idToken;
      delete next.needsLogin;
      writeOAuthEntry(authFile, provider, next);
      return next;
    },
    deps.lockWaitMs === undefined ? {} : { waitMs: deps.lockWaitMs },
  );
}

/**
 * 取可用的条目：新鲜就直接返回，否则刷新。`force`：协议层 401 后强制刷新（`staleToken` 是被拒的那个，别的
 * 进程已换掉它就直接用新的）。条目不存在返回 undefined；`needsLogin` 抛 `auth_expired`。
 */
export async function freshOAuthEntry(
  authFile: string,
  provider: string,
  deps: RefreshDeps = {},
  options: { force?: boolean; staleToken?: string } = {},
): Promise<OAuthAuthEntry | undefined> {
  const now = deps.now ?? Date.now;
  const entry = readOAuthEntry(authFile, provider);
  if (entry === undefined) return undefined;
  if (entry.needsLogin === true) throw authExpiredError(provider);
  const force =
    options.force === true && entry.accessToken === (options.staleToken ?? entry.accessToken);
  if (!force && isFresh(entry, now())) return entry;
  const key = `${authFile}\0${provider}`;
  let pending = inflight.get(key);
  if (pending === undefined) {
    pending = refreshLocked(authFile, provider, entry, force, deps).finally(() =>
      inflight.delete(key),
    );
    inflight.set(key, pending);
  }
  return pending;
}
