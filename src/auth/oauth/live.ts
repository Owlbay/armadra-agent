/**
 * 进程内「活 token」登记（[W6-O]）：`ApiKeyResolver` 解析出 OAuth access token 时登记它的上下文，协议层
 * （openai-responses 的 ChatGPT 后端）凭手里的 token 取回账户 id、flavor，并在 401 时强制刷新一次。
 *
 * 只存在内存里，不落盘、不进日志；最多保留 32 条（新的挤掉旧的）。
 */

import type { ChatGptFlavor } from "../../config/types-w6.js";

export interface LiveToken {
  provider: string;
  flavor: ChatGptFlavor;
  accountId?: string | undefined;
  planType?: string | undefined;
  /** 刷新永久失败、等用户重新登录：协议层不发请求，直接报 `auth_expired`。 */
  needsLogin?: boolean;
  /** 强制刷新（取锁、重读、必要时调 token 端点）；返回新 token，失败抛 `auth_expired`。 */
  refresh(): Promise<string>;
}

const MAX_LIVE = 32;
const live = new Map<string, LiveToken>();

export function registerLiveToken(token: string, context: LiveToken): void {
  live.delete(token);
  live.set(token, context);
  while (live.size > MAX_LIVE) {
    const oldest = live.keys().next().value;
    if (oldest === undefined) break;
    live.delete(oldest);
  }
}

export function liveToken(token: string | undefined): LiveToken | undefined {
  return token === undefined ? undefined : live.get(token);
}

/** 测试用。 */
export function clearLiveTokens(): void {
  live.clear();
}
