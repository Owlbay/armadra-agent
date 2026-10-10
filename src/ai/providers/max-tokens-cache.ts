/**
 * `max_tokens` 上限的跨进程缓存：`<dataDir>/models/max-tokens-caps.json`（#152）。
 *
 * 被动修正（apis/max-tokens.ts）学到的 `provider/model` 上限原本只在进程内，重启后每个模型的首个请求仍被
 * 400 拒一次。这里把它写进数据目录：组装注册表时载回进程内的表（进程内已有的键优先），学到新上限就把文件里
 * 未过期的条目加上这一条原子写回（临时文件 + 改名；并发进程后写者赢，丢的一条下次再学）。条目 30 天过期，
 * 过期后重新探测（中转放宽上限时不会一直压低输出）；删掉文件即重测。只存模型引用、上限与时间，没有凭据。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { maxTokensCaps, onMaxTokensCap } from "../apis/max-tokens.js";

export const MAX_TOKENS_CACHE_VERSION = 1;
/** 条目有效期：30 天。 */
export const MAX_TOKENS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CapEntry {
  cap: number;
  /** 学到的时间（毫秒时间戳）。 */
  learnedAt: number;
}

/** 缓存文件位置。 */
export function maxTokensCachePath(dataDir: string): string {
  return join(dataDir, "models", "max-tokens-caps.json");
}

/** 读文件里未过期的条目；不存在、坏 JSON、版本不符或形状不对的条目一律忽略。 */
function readEntries(dataDir: string, now: number): Map<string, CapEntry> {
  const out = new Map<string, CapEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(maxTokensCachePath(dataDir), "utf8"));
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null) return out;
  const file = parsed as { version?: unknown; caps?: unknown };
  if (file.version !== MAX_TOKENS_CACHE_VERSION) return out;
  if (typeof file.caps !== "object" || file.caps === null) return out;
  for (const [key, value] of Object.entries(file.caps as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const { cap, learnedAt } = value as Record<string, unknown>;
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) continue;
    if (typeof learnedAt !== "number" || !Number.isFinite(learnedAt)) continue;
    if (now - learnedAt > MAX_TOKENS_CACHE_TTL_MS) continue;
    out.set(key, { cap, learnedAt });
  }
  return out;
}

/** 载入未过期的上限到进程内的表（已有的键不覆盖）；返回载入条数。 */
export function loadMaxTokensCaps(dataDir: string, now: () => number = Date.now): number {
  let loaded = 0;
  for (const [key, entry] of readEntries(dataDir, now())) {
    if (maxTokensCaps.has(key)) continue;
    maxTokensCaps.set(key, entry.cap);
    loaded++;
  }
  return loaded;
}

/** 把一条新上限并入文件（顺带清掉过期条目）；写失败不抛（缓存只是省一次 400）。 */
export function recordMaxTokensCap(
  dataDir: string,
  key: string,
  cap: number,
  now: () => number = Date.now,
): void {
  const at = now();
  const entries = readEntries(dataDir, at);
  entries.set(key, { cap, learnedAt: at });
  const path = maxTokensCachePath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const caps = Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(tmp, `${JSON.stringify({ version: MAX_TOKENS_CACHE_VERSION, caps }, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // 只读数据目录等：本进程内的表仍有效
  }
}

const attached = new Map<string, () => void>();

/**
 * 载入并订阅：之后学到的上限写回该数据目录。按 `dataDir` 幂等（同一进程重复组装注册表不重复订阅）；
 * 返回取消函数（取消后可重新 attach）。
 */
export function attachMaxTokensCache(dataDir: string, now: () => number = Date.now): () => void {
  const existing = attached.get(dataDir);
  if (existing !== undefined) return existing;
  loadMaxTokensCaps(dataDir, now);
  const unsubscribe = onMaxTokensCap((key, cap) => recordMaxTokensCap(dataDir, key, cap, now));
  const detach = (): void => {
    unsubscribe();
    attached.delete(dataDir);
  };
  attached.set(dataDir, detach);
  return detach;
}
