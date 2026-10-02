/**
 * `ama doctor` 的 OAuth 行（[W6-O]）：只读文件、不刷新 token；codex flavor 且 token 未过期时查一次
 * `wham/usage`（3 s 超时，失败静默）显示配额，SIWC 只给查看位置。
 */

import type { ChatGptAuthConfig, OAuthAuthEntry } from "../../config/types-w6.js";
import { formatDuration, msg } from "../../i18n/index.js";
import type { FetchLike } from "../oauth/token-client.js";
import { fetchCodexUsage } from "./backend-client.js";
import { chatgptBaseUrl } from "./presets.js";
import { quotaParts } from "./quota-text.js";

export interface OAuthDoctorLines {
  line: string;
  quota?: string;
  problem?: string;
}

export async function oauthDoctorLines(
  provider: string,
  entry: OAuthAuthEntry,
  options: {
    now?: number;
    fetch?: FetchLike;
    env?: Readonly<Record<string, string | undefined>>;
    config?: ChatGptAuthConfig | undefined;
  } = {},
): Promise<OAuthDoctorLines> {
  const m = msg().auth;
  const now = options.now ?? Date.now();
  const left = entry.expiresAt - now;
  const state =
    entry.needsLogin === true
      ? m.doctor.needsLogin
      : left > 0
        ? m.doctor.valid(formatDuration(left))
        : m.doctor.expired;
  const out: OAuthDoctorLines = { line: m.doctor.oauth(entry.flavor, entry.planType, state) };
  if (entry.needsLogin === true) {
    out.problem = m.doctor.relogin(provider);
    return out;
  }
  if (entry.flavor === "siwc") out.quota = m.status.quotaSiwc.trim();
  else if (left > 0) {
    const quota = await fetchCodexUsage(
      options.fetch ?? fetch,
      chatgptBaseUrl("codex", options.env),
      {
        flavor: "codex",
        accessToken: entry.accessToken,
        accountId: entry.accountId,
        originator: options.config?.originator,
      },
      3_000,
    );
    const parts = quota === undefined ? undefined : quotaParts(quota, now);
    out.quota = (parts === undefined ? m.status.quotaUnavailable : m.status.quota(parts)).trim();
  }
  return out;
}
