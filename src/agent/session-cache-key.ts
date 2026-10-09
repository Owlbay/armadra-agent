/**
 * `prompt_cache_key` 的取值（docs/model-efficiency-plan.md §1.8，从 session-cache.ts 搬出，行为不变）：
 * fork 出的会话沿用 fork 链上的根会话 id（只是路由提示）；task 子会话与非 fork 会话用自己的 id。
 */

import { readFileSync } from "node:fs";
import type { SessionManager } from "../session/manager.js";

const TASK_CUSTOM_TYPE = "ama.task";

function readHead(file: string): { id?: string; parentSession?: string; task: boolean } {
  try {
    const [header, first] = readFileSync(file, "utf8").split("\n", 2);
    const parsed = JSON.parse(header ?? "{}") as { id?: string; parentSession?: string };
    const entry = first ? (JSON.parse(first) as { customType?: string }) : undefined;
    return { ...parsed, task: entry?.customType === TASK_CUSTOM_TYPE };
  } catch {
    return { task: false };
  }
}

/** fork 链上的根会话 id（task 子会话与非 fork 会话用自己的 id）。 */
export function cacheKeyOf(manager: SessionManager): string {
  const header = manager.header();
  const isTask = manager
    .entries()
    .some((entry) => entry.type === "custom" && entry.customType === TASK_CUSTOM_TYPE);
  if (header.parentSession === undefined || isTask) return manager.id;
  let id = manager.id;
  let file: string | undefined = header.parentSession;
  for (let depth = 0; depth < 8 && file !== undefined; depth++) {
    const head = readHead(file);
    if (head.id === undefined || head.task) break;
    id = head.id;
    file = head.parentSession;
  }
  return id;
}
