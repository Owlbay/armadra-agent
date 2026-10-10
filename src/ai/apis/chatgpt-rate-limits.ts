/**
 * ChatGPT 订阅配额解析（docs/history/wave6-plan.md §4.1 配额行、D17；R6 §1.2 配额三行）。[W6-O]
 *
 * - 响应头（codex flavor）：`x-codex-primary-used-percent` / `-window-minutes` / `-reset-at`（epoch 秒），
 *   `secondary` 同形；
 * - SSE（codex flavor）：`{"type":"codex.rate_limits","plan_type",…,"rate_limits":{"primary":{used_percent,
 *   window_minutes,reset_at},"secondary":…}}`；
 * - `GET /wham/usage`（codex flavor，`ama auth status` 用）：`{plan_type, rate_limit:{primary_window:{used_percent,
 *   limit_window_seconds, reset_at}, secondary_window}}`——私有格式，解析失败静默；
 * - 429（两种 flavor）：`resets_at`（秒）→ primary 用满。
 *
 * 输出统一为 `QuotaSnapshot`，时间换成 epoch 毫秒；会话层转成 `quota_update` 事件。
 */

import type { QuotaWindow } from "../../agent/types-w6.js";

export interface QuotaSnapshot {
  planType?: string;
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
}

type Json = Record<string, unknown>;

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/**
 * 一个窗口；时长 ≤ 0 视同缺失。[W7] 用量 0、无时长、无重置时间的窗口是服务端的「没有这个窗口」（套餐只有一个
 * 窗口时另一个槽位送全 0），返回 undefined——0.6.3 把它当成窗口渲染出 `0d: 0.0%`。
 */
function window(used: unknown, minutes: unknown, resetSeconds: unknown): QuotaWindow | undefined {
  const usedPercent = num(used);
  if (usedPercent === undefined) return undefined;
  const out: QuotaWindow = { usedPercent: Math.max(0, Math.min(100, usedPercent)) };
  const m = num(minutes);
  if (m !== undefined && m > 0) out.windowMinutes = m;
  const reset = num(resetSeconds);
  if (reset !== undefined && reset > 0) out.resetsAt = reset * 1000;
  const empty =
    out.usedPercent === 0 && out.windowMinutes === undefined && out.resetsAt === undefined;
  return empty ? undefined : out;
}

function snapshot(
  primary: QuotaWindow | undefined,
  secondary: QuotaWindow | undefined,
  plan: unknown,
): QuotaSnapshot | undefined {
  const out: QuotaSnapshot = {};
  if (typeof plan === "string" && plan !== "") out.planType = plan;
  if (primary !== undefined) out.primary = primary;
  if (secondary !== undefined) out.secondary = secondary;
  return primary === undefined && secondary === undefined ? undefined : out;
}

export function parseQuotaHeaders(
  headers: Pick<Headers, "get">,
  family = "codex",
): QuotaSnapshot | undefined {
  const p = `x-${family}`;
  const get = (name: string): string | null => headers.get(`${p}-${name}`);
  return snapshot(
    window(get("primary-used-percent"), get("primary-window-minutes"), get("primary-reset-at")),
    window(
      get("secondary-used-percent"),
      get("secondary-window-minutes"),
      get("secondary-reset-at"),
    ),
    undefined,
  );
}

export function parseRateLimitEvent(data: Json): QuotaSnapshot | undefined {
  if (data["type"] !== "codex.rate_limits") return undefined;
  const limits = obj(data["rate_limits"]);
  const w = (value: unknown): QuotaWindow | undefined => {
    const o = obj(value);
    return o === undefined
      ? undefined
      : window(o["used_percent"], o["window_minutes"], o["reset_at"]);
  };
  return snapshot(w(limits?.["primary"]), w(limits?.["secondary"]), data["plan_type"]);
}

export function parseUsagePayload(value: unknown): QuotaSnapshot | undefined {
  const body = obj(value);
  const limit = obj(body?.["rate_limit"]);
  const w = (raw: unknown): QuotaWindow | undefined => {
    const o = obj(raw);
    if (o === undefined) return undefined;
    const seconds = num(o["limit_window_seconds"]);
    return window(
      o["used_percent"],
      seconds === undefined ? undefined : seconds / 60,
      o["reset_at"],
    );
  };
  const out = snapshot(
    w(limit?.["primary_window"]),
    w(limit?.["secondary_window"]),
    body?.["plan_type"],
  );
  if (out === undefined && typeof body?.["plan_type"] === "string")
    return { planType: body["plan_type"] };
  return out;
}

/** 429 体里的 `resets_at`（秒）→ primary 用满。 */
export function quotaFromLimitError(error: Json): QuotaSnapshot {
  const reset = num(error["resets_at"]);
  const minutes = num(error["limit_window_minutes"]);
  const primary: QuotaWindow = { usedPercent: 100 };
  if (reset !== undefined) primary.resetsAt = reset * 1000;
  if (minutes !== undefined) primary.windowMinutes = minutes;
  const out: QuotaSnapshot = { primary };
  if (typeof error["plan_type"] === "string") out.planType = error["plan_type"];
  return out;
}
