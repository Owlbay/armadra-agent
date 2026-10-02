/**
 * 配额的人读文本（`ama auth status`、`/session`、doctor 共用）。[W6-O]
 *
 * `5 小时 42%（14:20 重置）· 周 18%（10-09 08:00 重置）`；重置时间按本地时区，24 小时内只给时分。
 */

import type { QuotaWindow } from "../../agent/types-w6.js";
import { formatDuration, msg } from "../../i18n/index.js";

export interface QuotaLike {
  primary?: QuotaWindow | undefined;
  secondary?: QuotaWindow | undefined;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function resetClock(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return at - now < 24 * 3_600_000 ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function windowName(minutes: number | undefined, fallback: "primary" | "secondary"): string {
  const m = msg().auth.status;
  if (minutes === 300) return m.window5h;
  if (minutes === 10_080) return m.windowWeek;
  if (minutes !== undefined) return m.windowOther(formatDuration(minutes * 60_000));
  return fallback === "primary" ? m.window5h : m.windowWeek;
}

/** 没有任何窗口时 undefined。 */
export function quotaParts(quota: QuotaLike, now: number = Date.now()): string | undefined {
  const m = msg().auth.status;
  const parts: string[] = [];
  for (const which of ["primary", "secondary"] as const) {
    const w = quota[which];
    if (w === undefined) continue;
    parts.push(
      m.quotaWindow(
        windowName(w.windowMinutes, which),
        Math.round(w.usedPercent),
        w.resetsAt === undefined ? undefined : resetClock(w.resetsAt, now),
      ),
    );
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}
