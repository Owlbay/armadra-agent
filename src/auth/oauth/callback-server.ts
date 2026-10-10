/**
 * 本地 OAuth 回调服务（docs/history/wave6-plan.md §4.1 回调行；R6 §4.3）。[W6-O]
 *
 * - 只监听 `127.0.0.1`；端口按 `ports` 依次尝试（0 = 任意空闲端口），被占用就试下一个；全被占用报
 *   `oauth_ports_busy`（**不**像别的客户端那样发 `/cancel` 抢占他人的监听）；
 * - 只认 `GET <path>`：`state` 不符 → `oauth_state_mismatch`；带 `error` → `oauth_denied`（只带 error 码，
 *   不带描述原文）；成功返回静态页，**页面不回显 code**；
 * - 超时（缺省 5 分钟）→ `oauth_timeout`；signal 中止 → `aborted`。结束后自动关闭监听。
 *
 * `parseCallbackUrl` 给 `--paste` 用：校验粘回来的回调 URL 的 state 并取出 code。
 * SIWC 首次动态注册时回调还带签发的 `client_id` 与授予的 `scope`（空格分隔），一并交出。
 */

import { createServer, type Server } from "node:http";
import { AmaError } from "../../errors.js";

export const CALLBACK_PATH = "/auth/callback";
export const CALLBACK_HOST = "127.0.0.1";
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface CallbackPages {
  success: string;
  failure: string;
}

export interface CallbackServerOptions {
  ports: readonly number[];
  state: string;
  path?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  pages?: CallbackPages | undefined;
}

/** 回调里的有用参数（不含 state）。 */
export interface CallbackParams {
  code: string;
  /** SIWC 动态注册签发的 client id。 */
  clientId?: string;
  /** 授予的 scope（空格分隔）。 */
  scope?: string;
}

export interface CallbackServer {
  port: number;
  redirectUri: string;
  /** 收到合法回调后 resolve；失败 reject AmaError。 */
  result: Promise<CallbackParams>;
  close(): Promise<void>;
}

const DEFAULT_PAGES: CallbackPages = {
  success: "Signed in. You can close this page and return to the terminal.",
  failure: "Sign-in failed. Return to the terminal for details.",
};

function page(text: string): string {
  const escaped = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>ama</title><body style="font-family:sans-serif;padding:3em"><p>${escaped}</p></body>`;
}

/** 回调参数 → code；state 不符 / 带 error / 缺 code 抛 AmaError（不含 code 原文）。 */
export function codeFromParams(params: URLSearchParams, state: string): CallbackParams {
  const error = params.get("error");
  if (error !== null) {
    throw new AmaError("oauth_denied", `authorization failed: ${error.slice(0, 64)}`, {
      detail: { error: error.slice(0, 64) },
    });
  }
  if (params.get("state") !== state) {
    throw new AmaError("oauth_state_mismatch", "OAuth state mismatch");
  }
  const code = params.get("code");
  if (code === null || code === "") throw new AmaError("oauth_no_code", "callback has no code");
  const out: CallbackParams = { code };
  const clientId = params.get("client_id");
  if (clientId) out.clientId = clientId;
  const scope = params.get("scope");
  if (scope) out.scope = scope;
  return out;
}

/** `--paste`：粘回来的整条回调 URL（或只有查询串）。 */
export function parseCallbackUrl(input: string, state: string): CallbackParams {
  const text = input.trim();
  let params: URLSearchParams;
  try {
    params = new URL(text).searchParams;
  } catch {
    params = new URLSearchParams(text.startsWith("?") ? text.slice(1) : text);
  }
  return codeFromParams(params, state);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, CALLBACK_HOST);
  });
}

export async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer> {
  const path = options.path ?? CALLBACK_PATH;
  const pages = options.pages ?? DEFAULT_PAGES;
  let settle:
    { resolve: (params: CallbackParams) => void; reject: (error: unknown) => void } | undefined;
  const result = new Promise<CallbackParams>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // 调用方可能只在失败时才 await
  result.catch(() => {});
  let done = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${CALLBACK_HOST}`);
    if (req.method !== "GET" || url.pathname !== path || done) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    try {
      const params = codeFromParams(url.searchParams, options.state);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(pages.success));
      finish(undefined, params);
    } catch (error) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page(pages.failure));
      // state 不符可能是别人的请求：只有 error 回调才结束等待
      if ((error as AmaError).code !== "oauth_state_mismatch") finish(error);
    }
  });
  let port: number | undefined;
  for (const candidate of options.ports) {
    try {
      port = await listen(server, candidate);
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EADDRINUSE") throw error;
    }
  }
  if (port === undefined) {
    throw new AmaError("oauth_ports_busy", `callback ports busy: ${options.ports.join(", ")}`, {
      detail: { ports: [...options.ports] },
    });
  }
  const timer = setTimeout(
    () => finish(new AmaError("oauth_timeout", "login timed out")),
    options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
  );
  const onAbort = (): void => finish(new AmaError("aborted", "login aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  function finish(error: unknown, params?: CallbackParams): void {
    if (done) return;
    done = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    server.close();
    server.closeAllConnections?.();
    if (params !== undefined) settle?.resolve(params);
    else settle?.reject(error);
  }
  if (options.signal?.aborted) onAbort();
  return {
    port,
    redirectUri: `http://${CALLBACK_HOST}:${port}${path}`,
    result,
    close: async () => {
      finish(new AmaError("aborted", "login aborted"));
    },
  };
}
