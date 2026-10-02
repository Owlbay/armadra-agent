/**
 * 记忆的人读文本（`/memory` 行式、`ama memory`、面板共用）。[W6-M] 界面层：文案走 `msg().memory`。
 */

import { formatBytes } from "../checkpoints/gc.js";
import { msg } from "../i18n/index.js";
import type { MemoryEntry } from "./index.js";
import { MemoryLockError } from "./lock.js";
import { logicalPath, type MemoryScope } from "./paths.js";
import type { MemoryRuntime } from "./runtime.js";
import { scopeIndex } from "./section.js";
import { MemoryError, type MemoryStore } from "./store.js";

export const STALE_DAYS = 90;

export function scopeLabel(scope: MemoryScope): string {
  return msg().memory.scope[scope];
}

/** 条目是否超过 90 天未更新（`/memory` 标灰）。 */
export function isStale(entry: Pick<MemoryEntry, "updated">, now: number): boolean {
  const at = Date.parse(`${entry.updated}T00:00:00Z`);
  return Number.isFinite(at) && now - at > STALE_DAYS * 86_400_000;
}

/** 存储错误 → 本地化说明；不是存储错误时原样抛出。 */
export function memoryErrorText(error: unknown): string {
  const m = msg().memory.error;
  if (error instanceof MemoryLockError) return m.locked;
  if (!(error instanceof MemoryError)) throw error;
  const d = error.detail ?? {};
  switch (error.code) {
    case "credential":
      return m.credential(String(d["kind"] ?? "secret"));
    case "too_large":
      return m.tooLarge(Number(d["bytes"]), Number(d["limit"]));
    case "too_many":
      return m.tooMany(Number(d["limit"]));
    default:
      return m.other(error.message);
  }
}

export type FindResult = { ok: true; entry: MemoryEntry } | { ok: false; message: string };

export function findOne(store: MemoryStore, name: string): FindResult {
  const m = msg().memory.command;
  const found = store.find(name);
  if (found.length === 0) return { ok: false, message: m.notFound(name) };
  if (found.length > 1)
    return {
      ok: false,
      message: m.ambiguous(name, found.map((e) => `${e.scope}/${e.file}`).join(", ")),
    };
  return { ok: true, entry: found[0] as MemoryEntry };
}

export interface ScopeSummary {
  scope: MemoryScope;
  entries: MemoryEntry[];
  indexBytes: number;
  omitted: number;
}

export function scopeSummaries(store: MemoryStore, scopes = store.scopes()): ScopeSummary[] {
  return scopes.map((scope) => {
    const entries = store.entries(scope);
    const index = scopeIndex(scope, entries, store.limits.indexMaxBytes);
    return { scope, entries, indexBytes: index.bytes, omitted: index.omitted };
  });
}

/** 纯文本列表（行式 `/memory`、`ama memory list`）。 */
export function listText(
  store: MemoryStore,
  options: { scopes?: MemoryScope[]; now?: number; notes?: string[] } = {},
): string {
  const m = msg().memory.panel;
  const now = options.now ?? Date.now();
  const lines: string[] = [];
  for (const s of scopeSummaries(store, options.scopes)) {
    lines.push(
      m.scopeLine(
        `${scopeLabel(s.scope)} ${logicalPath(s.scope)}/`,
        s.entries.length,
        formatBytes(s.indexBytes),
        formatBytes(store.limits.indexMaxBytes),
      ),
    );
    if (s.entries.length === 0) lines.push(`  ${m.noEntries}`);
    for (const e of s.entries) {
      const stale = isStale(e, now) ? ` (${m.stale})` : "";
      const description = e.description === "" ? "" : ` — ${e.description}`;
      lines.push(`  ${e.name} [${e.file}]${description} · ${m.entryUpdated(e.updated)}${stale}`);
    }
    if (s.omitted > 0) lines.push(`  ${m.truncated(s.omitted)}`);
  }
  lines.push(...(options.notes ?? []));
  return lines.join("\n");
}

/** 运行期附加说明：项目作用域因未信任跳过、本会话禁止写入。 */
export function runtimeNotes(runtime: MemoryRuntime): string[] {
  const m = msg().memory.panel;
  const notes: string[] = [];
  if (runtime.skipped.some((s) => s.reason === "untrusted")) notes.push(m.untrusted);
  if (!runtime.writesEnabled) notes.push(m.writesOff);
  return notes;
}
