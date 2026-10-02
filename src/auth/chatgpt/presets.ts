/**
 * ChatGPT 登录预设表（docs/wave6-plan.md §4.1、D13–D16；R6 §1.1、§1.2、§4.10）。[W6-O]
 *
 * 两条路径共用 PKCE / 回调 / 存储 / 锁 / 配额框架，差异全部在这张表里：
 * - `siwc`（缺省，官方动态注册）：`/api/accounts/*`，首次 `client_id=dynamic_agent_client`，回调带回签发的
 *   id 后存进条目；表单编码、带 `resource`；id_token 必须 JWKS 验签；推理走 `api.openai.com/v1`；
 * - `codex`（显式开启的备用）：Codex CLI 的公开客户端，`/oauth/*`，刷新 JSON 编码；id_token 只解码；
 *   推理走 `chatgpt.com/backend-api/codex`，另发 `ChatGPT-Account-ID` 与 `originator`。
 *
 * 覆盖：`AMA_CHATGPT_CLIENT_ID` / `AMA_CHATGPT_ISSUER`（测试用）/ `AMA_CHATGPT_BASE_URL` > 配置
 * `auth.chatgpt.*` > 条目里签发的 client id > 缺省。
 */

import type { ChatGptAuthConfig, ChatGptFlavor, OAuthAuthEntry } from "../../config/types-w6.js";

export const CHATGPT_PROVIDER_ID = "chatgpt";
export const DEFAULT_ISSUER = "https://auth.openai.com";
export const SIWC_REGISTRATION_CLIENT_ID = "dynamic_agent_client";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
export const AGENT_NAME_HINT = "ama";
export const DEFAULT_ORIGINATOR = "codex_cli_rs";
export const CHATGPT_BASE_URLS: Readonly<Record<ChatGptFlavor, string>> = {
  siwc: "https://api.openai.com/v1",
  codex: "https://chatgpt.com/backend-api/codex",
};

export interface AuthorizeInput {
  redirectUri: string;
  state: string;
  challenge: string;
  nonce: string;
  /** SIWC：`<dataDir>/chatgpt-host.json` 的安装 id。 */
  hostId?: string | undefined;
}

export interface ChatGptPreset {
  flavor: ChatGptFlavor;
  issuer: string;
  clientId: string;
  /** SIWC 还没有签发 id（用注册入口登录）。 */
  registering: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  redirectPorts: readonly number[];
  /** SIWC 的 `resource`（交换与刷新都带）。 */
  resource?: string;
  refreshEncoding: "form" | "json";
  /** 推理端点（渠道 baseUrl）。 */
  baseUrl: string;
  /** SIWC：id_token 必须 JWKS 验签，且授予 scope 含 `chatgpt.tokens.use.direct`。 */
  verifyIdToken: boolean;
  requiredScope?: string;
  /** 设备码（只有 codex）。 */
  device: boolean;
  /** 登出调 revocation_endpoint（只有 SIWC）。 */
  revoke: boolean;
  originator?: string;
}

export interface PresetOverrides {
  config?: ChatGptAuthConfig | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** 已有条目：SIWC 复用签发的 client id。 */
  entry?: OAuthAuthEntry | undefined;
  /** `--port N`。 */
  port?: number | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function chatgptBaseUrl(
  flavor: ChatGptFlavor,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return nonEmpty(env["AMA_CHATGPT_BASE_URL"]) ?? CHATGPT_BASE_URLS[flavor];
}

export function resolveChatGptPreset(
  flavor: ChatGptFlavor,
  overrides: PresetOverrides = {},
): ChatGptPreset {
  const env = overrides.env ?? process.env;
  const config = overrides.config;
  const issuer = (
    nonEmpty(env["AMA_CHATGPT_ISSUER"]) ??
    nonEmpty(config?.issuer) ??
    DEFAULT_ISSUER
  ).replace(/\/+$/, "");
  const sameFlavor = overrides.entry?.flavor === flavor ? overrides.entry : undefined;
  const explicitClient = nonEmpty(env["AMA_CHATGPT_CLIENT_ID"]) ?? nonEmpty(config?.clientId);
  const ports =
    overrides.port !== undefined
      ? [overrides.port]
      : config?.redirectPorts !== undefined && config.redirectPorts.length > 0
        ? [...config.redirectPorts]
        : undefined;
  if (flavor === "siwc") {
    const issued =
      sameFlavor?.clientId !== SIWC_REGISTRATION_CLIENT_ID ? sameFlavor?.clientId : undefined;
    const clientId = explicitClient ?? issued ?? SIWC_REGISTRATION_CLIENT_ID;
    return {
      flavor,
      issuer,
      clientId,
      registering: clientId === SIWC_REGISTRATION_CLIENT_ID,
      authorizeUrl: `${issuer}/api/accounts/authorize`,
      tokenUrl: `${issuer}/api/accounts/oauth/token`,
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "resource.invoke",
        SIWC_REQUIRED_SCOPE,
      ],
      // 端口可变（scheme / host / path 不变）：1455 被占用就用任意空闲端口
      redirectPorts: ports ?? [1455, 0],
      resource: SIWC_RESOURCE,
      refreshEncoding: "form",
      baseUrl: chatgptBaseUrl(flavor, env),
      verifyIdToken: true,
      requiredScope: SIWC_REQUIRED_SCOPE,
      device: false,
      revoke: true,
    };
  }
  return {
    flavor,
    issuer,
    clientId: explicitClient ?? CODEX_CLIENT_ID,
    registering: false,
    authorizeUrl: `${issuer}/oauth/authorize`,
    tokenUrl: `${issuer}/oauth/token`,
    scopes: ["openid", "profile", "email", "offline_access"],
    // 公开客户端只登记了这两个端口；被占用不抢占
    redirectPorts: ports ?? [1455, 1457],
    refreshEncoding: "json",
    baseUrl: chatgptBaseUrl(flavor, env),
    verifyIdToken: false,
    device: true,
    revoke: false,
    originator: nonEmpty(config?.originator) ?? DEFAULT_ORIGINATOR,
  };
}

/** 授权 URL（参数顺序固定，便于测试）。 */
export function authorizeUrl(preset: ChatGptPreset, input: AuthorizeInput): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: preset.clientId,
    redirect_uri: input.redirectUri,
    scope: preset.scopes.join(" "),
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
  });
  if (preset.flavor === "siwc") {
    params.set("nonce", input.nonce);
    if (preset.resource !== undefined) params.set("resource", preset.resource);
    if (input.hostId !== undefined) params.set("ext_agent_host_id", input.hostId);
    // 只在首次动态注册时带
    if (preset.registering) params.set("agent_name_hint", AGENT_NAME_HINT);
  } else {
    params.set("id_token_add_organizations", "true");
    params.set("codex_cli_simplified_flow", "true");
    if (preset.originator !== undefined) params.set("originator", preset.originator);
  }
  return `${preset.authorizeUrl}?${params.toString()}`;
}
