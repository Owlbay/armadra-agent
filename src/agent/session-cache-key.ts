/**
 * `prompt_cache_key` 的取值（docs/model-efficiency-plan.md §1.8，从 session-cache.ts 搬出）：
 * fork 出的会话沿用 fork 链上的根会话 id（只是路由提示）；task 子会话与非 fork 会话用自己的 id。
 * [ME-A] fork 式子会话（首条 `ama.task{context:"fork"}`）继承父的前缀，不当作 task 子会话：沿用父链根 id。
 */

import { readFileSync } from "node:fs";
import type { SessionManager } from "../session/manager.js";

const TASK_CUSTOM_TYPE = "ama.task";

/** 首条是不是 fresh 式 task 子会话的标记（fork 式子会话不算）。 */
function isTaskHead(entry: { customType?: string; data?: unknown } | undefined): boolean {
  if (entry?.customType !== TASK_CUSTOM_TYPE) return false;
  const data = entry.data as { context?: unknown } | undefined;
  return data?.context !== "fork";
}

function readHead(file: string): { id?: string; parentSession?: string; task: boolean } {
  try {
    const [header, first] = readFileSync(file, "utf8").split("\n", 2);
    const parsed = JSON.parse(header ?? "{}") as { id?: string; parentSession?: string };
    const entry = first ? (JSON.parse(first) as { customType?: string }) : undefined;
    return { ...parsed, task: isTaskHead(entry) };
  } catch {
    return { task: false };
  }
}

/** fork 链上的根会话 id（task 子会话与非 fork 会话用自己的 id）。 */
export function cacheKeyOf(manager: SessionManager): string {
  const header = manager.header();
  const entries = manager.entries();
  const head = entries[0];
  const forkTask =
    head?.type === "custom" && head.customType === TASK_CUSTOM_TYPE && !isTaskHead(head);
  const isTask =
    !forkTask &&
    entries.some((entry) => entry.type === "custom" && entry.customType === TASK_CUSTOM_TYPE);
  if (header.parentSession === undefined || isTask) return manager.id;
  let id = manager.id;
  let file: string | undefined = header.parentSession;
  for (let depth = 0; depth < 8 && file !== undefined; depth++) {
    const next = readHead(file);
    if (next.id === undefined || next.task) break;
    id = next.id;
    file = next.parentSession;
  }
  return id;
}
