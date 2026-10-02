/**
 * ChatGPT 登录 / 登出编排（docs/wave6-plan.md §4.1–§4.3、D13–D16）。[W6-O]
 *
 * 登录：预设 → 授权码（browser / paste / device）→ 换 token（表单编码；SIWC 带 `resource`，client id 用
 * 回调带回的签发 id）→ 校验（SIWC：JWKS 验签 iss / aud / nonce / exp + 授予 scope 含
 * `chatgpt.tokens.use.direct`；codex：只解码取账户）→ `OAuthAuthEntry`。写文件由调用方经 token-store 做。
 *
 * 登出：SIWC 调 discovery 里的 `revocation_endpoint`（`token=<refresh>`、`token_type_hint=refresh_token`、
 * `client_id`），失败不阻止删除本地条目；codex 只删本地。
 */

import { AmaError } from "../../errors.js";
import type { ChatGptFlavor, OAuthAuthEntry } from "../../config/types-w6.js";
import {
  loginBrowser,
  loginDevice,
  loginPaste,
  type AuthorizationResult,
  type FlowDeps,
  type FlowPreset,
} from "../oauth/flows.js";
import { jwtClaims } from "../oauth/jwt.js";
import { fetchDiscovery, validateIdToken } from "../oauth/oidc.js";
import { parseTokenResponse, postOAuth, type FetchLike } from "../oauth/token-client.js";
import { chatgptAccount, hasScope } from "./claims.js";
import { readOrCreateHostId } from "./host-id.js";
import {
  SIWC_REGISTRATION_CLIENT_ID,
  authorizeUrl,
  resolveChatGptPreset,
  type ChatGptPreset,
  type PresetOverrides,
} from "./presets.js";

export type LoginMethod = "browser" | "paste" | "device";

export interface ChatGptLoginOptions extends PresetOverrides {
  flavor: ChatGptFlavor;
  method: LoginMethod;
  noBrowser?: boolean;
  /** SIWC 的 `ext_agent_host_id` 存放目录（`<dataDir>`）。 */
  dataDir: string;
  /** codex 的一次性确认时刻（ISO）；调用方负责问。 */
  acknowledgedAt?: string | undefined;
  deps: FlowDeps;
}

export const DEFAULT_ACCESS_TTL_S = 3600;

function flowPreset(preset: ChatGptPreset, hostId: string | undefined): FlowPreset {
  return {
    issuer: preset.issuer,
    clientId: preset.clientId,
    redirectPorts: preset.redirectPorts,
    buildAuthorizeUrl: (input) => authorizeUrl(preset, { ...input, hostId }),
  };
}

function issuedClientId(
  preset: ChatGptPreset,
  auth: AuthorizationResult,
  tokenClientId: string | undefined,
  idToken: string | undefined,
): string {
  if (!preset.registering) return preset.clientId;
  const fromAud = (): string | undefined => {
    const aud = jwtClaims(idToken)?.["aud"];
    const list = Array.isArray(aud) ? aud : [aud];
    return list.find(
      (a): a is string => typeof a === "string" && a !== SIWC_REGISTRATION_CLIENT_ID,
    );
  };
  const issued = auth.clientId ?? tokenClientId ?? fromAud();
  if (issued === undefined || issued === SIWC_REGISTRATION_CLIENT_ID)
    throw new AmaError("oauth_no_client_id", "dynamic registration returned no client id");
  return issued;
}

export async function exchangeCode(
  fetchFn: FetchLike,
  preset: ChatGptPreset,
  auth: AuthorizationResult,
  signal?: AbortSignal,
): Promise<OAuthAuthEntry> {
  // 新注册：交换要用签发的 id（回调带回）；回调没带时先用注册入口换，再从 id_token 的 aud 取
  const exchangeClient = preset.registering ? (auth.clientId ?? preset.clientId) : preset.clientId;
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: auth.code,
    redirect_uri: auth.redirectUri,
    client_id: exchangeClient,
    code_verifier: auth.verifier,
  };
  if (preset.resource !== undefined) params["resource"] = preset.resource;
  const token = parseTokenResponse(
    await postOAuth(fetchFn, preset.tokenUrl, params, {
      encoding: "form",
      what: "token exchange",
      signal,
    }),
    "token exchange",
  );
  if (token.refreshToken === undefined)
    throw new AmaError("oauth_bad_response", "token exchange: no refresh_token");
  const clientId = issuedClientId(preset, auth, token.clientId, token.idToken);
  let claims = jwtClaims(token.idToken);
  if (preset.verifyIdToken) {
    if (token.idToken === undefined)
      throw new AmaError("oauth_invalid_token", "invalid id_token: missing");
    claims = await validateIdToken(fetchFn, token.idToken, {
      issuer: preset.issuer,
      audience: clientId,
      nonce: auth.nonce,
    });
    const scope = auth.scope ?? token.scope;
    if (preset.requiredScope !== undefined && !hasScope(scope, preset.requiredScope))
      throw new AmaError("oauth_scope_missing", `granted scope lacks ${preset.requiredScope}`, {
        detail: { scope: preset.requiredScope },
      });
  }
  const account = chatgptAccount(claims, preset.flavor);
  if (preset.flavor === "codex" && account.accountId === undefined)
    throw new AmaError("oauth_no_account", "id_token has no ChatGPT account id");
  const now = Date.now();
  const entry: OAuthAuthEntry = {
    type: "oauth",
    flavor: preset.flavor,
    clientId,
    issuer: preset.issuer,
    ...account,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    ...(token.idToken !== undefined ? { idToken: token.idToken } : {}),
    expiresAt: now + (token.expiresIn ?? DEFAULT_ACCESS_TTL_S) * 1000,
    lastRefresh: new Date(now).toISOString(),
  };
  return entry;
}

export async function loginChatGpt(options: ChatGptLoginOptions): Promise<OAuthAuthEntry> {
  const preset = resolveChatGptPreset(options.flavor, options);
  if (options.method === "device" && !preset.device)
    throw new AmaError("oauth_device_unsupported", "device code login needs --flavor codex");
  const hostId = preset.flavor === "siwc" ? readOrCreateHostId(options.dataDir) : undefined;
  const flow = flowPreset(preset, hostId);
  const auth =
    options.method === "device"
      ? await loginDevice(flow, options.deps)
      : options.method === "paste"
        ? await loginPaste(flow, options.deps)
        : await loginBrowser(flow, options.deps, { noBrowser: options.noBrowser === true });
  const entry = await exchangeCode(options.deps.fetch, preset, auth, options.deps.signal);
  if (options.acknowledgedAt !== undefined) entry.acknowledgedAt = options.acknowledgedAt;
  return entry;
}

/** SIWC 登出：撤销 refresh token。返回是否确认撤销（失败 / 不支持为 false，不抛）。 */
export async function revokeChatGpt(
  fetchFn: FetchLike,
  entry: OAuthAuthEntry,
  overrides: PresetOverrides = {},
): Promise<boolean> {
  const preset = resolveChatGptPreset(entry.flavor, { ...overrides, entry });
  if (!preset.revoke) return false;
  const issuer = entry.issuer ?? preset.issuer;
  try {
    const discovery = await fetchDiscovery(fetchFn, issuer);
    if (discovery.revocationEndpoint === undefined) return false;
    await postOAuth(
      fetchFn,
      discovery.revocationEndpoint,
      {
        token: entry.refreshToken,
        token_type_hint: "refresh_token",
        client_id: entry.clientId ?? preset.clientId,
      },
      { encoding: "form", what: "token revocation" },
    );
    return true;
  } catch {
    return false;
  }
}
