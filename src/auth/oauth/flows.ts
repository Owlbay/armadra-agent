/**
 * 授权流程（docs/history/wave6-plan.md §4.2、D16；R6 §4.2、§4.3、§1.2 设备码行）。[W6-O]
 *
 * 三种拿授权码的方式，产出同一个 `AuthorizationResult`，由各预设的登录模块去换 token：
 * - `browser`：本地回调服务 + 打开浏览器（打不开就只给 URL）；
 * - `paste`：只给 URL，用户把浏览器地址栏里的回调 URL 粘回来（SSH / 宿主场景）；
 * - `device`：设备码（只有 codex 预设），轮询 `/api/accounts/deviceauth/token`，15 分钟上限。
 *
 * 给人看的东西经 `onStep` 交给界面层渲染（i18n 在那里）；本模块不打印、不记日志，code 与 verifier
 * 只出现在返回值里。
 */

import { AmaError } from "../../errors.js";
import type { BrowserOpener } from "./browser.js";
import {
  CALLBACK_HOST,
  CALLBACK_PATH,
  parseCallbackUrl,
  startCallbackServer,
  type CallbackPages,
  type CallbackParams,
} from "./callback-server.js";
import { generatePkce, randomToken } from "./pkce.js";
import { OAuthHttpError, postOAuth, type FetchLike } from "./token-client.js";

export type LoginStep =
  | { kind: "open_url"; url: string; opened: boolean }
  | { kind: "paste_prompt"; url: string }
  | { kind: "device_code"; url: string; userCode: string };

export interface FlowDeps {
  fetch: FetchLike;
  openBrowser: BrowserOpener;
  onStep(step: LoginStep): void;
  /** `--paste`：读一行（回调 URL）。 */
  readLine(): Promise<string>;
  signal?: AbortSignal | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  pages?: CallbackPages | undefined;
  timeoutMs?: number | undefined;
}

export interface FlowPreset {
  issuer: string;
  clientId: string;
  redirectPorts: readonly number[];
  /** 给定回调地址与随机串，产出授权 URL。 */
  buildAuthorizeUrl(input: {
    redirectUri: string;
    state: string;
    challenge: string;
    nonce: string;
  }): string;
}

export interface AuthorizationResult extends CallbackParams {
  redirectUri: string;
  verifier: string;
  nonce: string;
}

export async function loginBrowser(
  preset: FlowPreset,
  deps: FlowDeps,
  options: { noBrowser?: boolean } = {},
): Promise<AuthorizationResult> {
  const pkce = generatePkce();
  const state = randomToken();
  const nonce = randomToken();
  const server = await startCallbackServer({
    ports: preset.redirectPorts,
    state,
    signal: deps.signal,
    pages: deps.pages,
    timeoutMs: deps.timeoutMs,
  });
  try {
    const url = preset.buildAuthorizeUrl({
      redirectUri: server.redirectUri,
      state,
      challenge: pkce.challenge,
      nonce,
    });
    const opened = options.noBrowser === true ? false : await deps.openBrowser(url);
    deps.onStep({ kind: "open_url", url, opened });
    const params = await server.result;
    return { ...params, redirectUri: server.redirectUri, verifier: pkce.verifier, nonce };
  } finally {
    await server.close();
  }
}

export async function loginPaste(preset: FlowPreset, deps: FlowDeps): Promise<AuthorizationResult> {
  const pkce = generatePkce();
  const state = randomToken();
  const nonce = randomToken();
  const port = preset.redirectPorts.find((p) => p > 0) ?? 1455;
  const redirectUri = `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;
  const url = preset.buildAuthorizeUrl({ redirectUri, state, challenge: pkce.challenge, nonce });
  deps.onStep({ kind: "paste_prompt", url });
  const line = await deps.readLine();
  if (line.trim() === "") throw new AmaError("aborted", "login aborted");
  const params = parseCallbackUrl(line, state);
  return { ...params, redirectUri, verifier: pkce.verifier, nonce };
}

export const DEVICE_MAX_WAIT_MS = 15 * 60_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AmaError("aborted", "login aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AmaError("aborted", "login aborted"));
      },
      { once: true },
    );
  });
}

/** 设备码：`{issuer}/api/accounts/deviceauth/usercode` → 用户在 `{issuer}/codex/device` 输入 → 轮询。 */
export async function loginDevice(
  preset: FlowPreset,
  deps: FlowDeps,
): Promise<AuthorizationResult> {
  const api = `${preset.issuer}/api/accounts`;
  let start: Record<string, unknown>;
  try {
    start = await postOAuth(
      deps.fetch,
      `${api}/deviceauth/usercode`,
      { client_id: preset.clientId },
      { encoding: "json", what: "device code request", signal: deps.signal },
    );
  } catch (error) {
    if (error instanceof OAuthHttpError && error.status === 404)
      throw new AmaError("oauth_device_unavailable", "device code login is not enabled");
    throw error;
  }
  const deviceAuthId = start["device_auth_id"];
  const userCode = start["user_code"] ?? start["usercode"];
  if (typeof deviceAuthId !== "string" || typeof userCode !== "string")
    throw new AmaError("oauth_bad_response", "device code request: unexpected response");
  const interval = Math.max(1, Number(start["interval"] ?? 5) || 5) * 1000;
  deps.onStep({ kind: "device_code", url: `${preset.issuer}/codex/device`, userCode });
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => defaultSleep(ms, deps.signal));
  const began = now();
  for (;;) {
    try {
      const done = await postOAuth(
        deps.fetch,
        `${api}/deviceauth/token`,
        { device_auth_id: deviceAuthId, user_code: userCode },
        { encoding: "json", what: "device code poll", signal: deps.signal },
      );
      const code = done["authorization_code"];
      const verifier = done["code_verifier"];
      if (typeof code !== "string" || typeof verifier !== "string")
        throw new AmaError("oauth_bad_response", "device code poll: unexpected response");
      return {
        code,
        verifier,
        nonce: "",
        redirectUri: `${preset.issuer}/deviceauth/callback`,
      };
    } catch (error) {
      const pending =
        error instanceof OAuthHttpError && (error.status === 403 || error.status === 404);
      if (!pending) throw error;
    }
    if (now() - began >= DEVICE_MAX_WAIT_MS)
      throw new AmaError("oauth_timeout", "device code login timed out");
    await sleep(interval);
  }
}
