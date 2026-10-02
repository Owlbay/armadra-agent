/**
 * id_token 声明里的账户信息（R6 §1.2 账户 id 行）。[W6-O]
 *
 * codex：`https://api.openai.com/auth` 下的 `chatgpt_account_id` / `chatgpt_plan_type`；SIWC：以验签后的
 * `sub` 作账户标识（官方文档），计划类型若有同样取 auth 声明。邮箱取 `email` 或 profile 声明。
 */

import type { JwtPayload } from "../oauth/jwt.js";

export interface ChatGptAccount {
  accountId?: string;
  planType?: string;
  email?: string;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function chatgptAccount(
  claims: JwtPayload | undefined,
  flavor: "siwc" | "codex",
): ChatGptAccount {
  if (claims === undefined) return {};
  const auth = obj(claims["https://api.openai.com/auth"]);
  const profile = obj(claims["https://api.openai.com/profile"]);
  const out: ChatGptAccount = {};
  const accountId =
    flavor === "codex"
      ? (str(auth?.["chatgpt_account_id"]) ?? str(claims["chatgpt_account_id"]))
      : (str(claims["sub"]) ?? str(auth?.["chatgpt_account_id"]));
  if (accountId !== undefined) out.accountId = accountId;
  const plan = str(auth?.["chatgpt_plan_type"]) ?? str(claims["chatgpt_plan_type"]);
  if (plan !== undefined) out.planType = plan;
  const email = str(claims["email"]) ?? str(profile?.["email"]);
  if (email !== undefined) out.email = email;
  return out;
}

/** 空格分隔的 scope 是否含 `required`。 */
export function hasScope(scope: string | undefined, required: string): boolean {
  return (scope ?? "").split(/[\s+]+/).includes(required);
}

/** `a***@example.com`：status / doctor 用。 */
export function maskEmail(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
