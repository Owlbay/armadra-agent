/**
 * codemode 的跨次存储（设计 §5.5 `store / load`）。[B10]
 *
 * - 存成 `custom{customType:"ama.codemode-store", data:{ entries }}` 条目（不进上下文）；每次成功
 *   的脚本写过 store 就追加一条**完整快照**，读取取活动分支上最近一条——随会话分支走，fork /
 *   切分支后只看本分支写过的值；
 * - 单值 JSON ≤ 262 144 字符、合计 ≤ 1 048 576 字符（子进程里 store() 先检查一次，这里提交前
 *   再检查一次，防止子进程被绕过）；
 * - 脚本失败不提交（由 tool.ts 保证：只在 `done.ok` 时调用 commitStore）。
 */

import type { ToolContext } from "../tools/types.js";
import type { StoreSnapshot } from "./protocol.js";

export const STORE_CUSTOM_TYPE = "ama.codemode-store";
export const MAX_STORE_VALUE_CHARS = 262_144;
export const MAX_STORE_TOTAL_CHARS = 1_048_576;

export interface StoreEntryData {
  entries: StoreSnapshot;
}

type SessionAccess = ToolContext["session"];

/** 活动分支上最近一次提交的快照；没有或形状不对 → 空。 */
export function readStore(session: SessionAccess): StoreSnapshot {
  const data = session.lastCustom(STORE_CUSTOM_TYPE) as Partial<StoreEntryData> | undefined;
  const entries = data?.entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return {};
  return { ...entries };
}

/** 超限 / 非法 → 说明文字；合法 → undefined。 */
export function validateStore(entries: StoreSnapshot): string | undefined {
  let total = 0;
  for (const [key, value] of Object.entries(entries)) {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      json = undefined;
    }
    if (json === undefined) return `store value "${key}" is not JSON-serializable`;
    if (json.length > MAX_STORE_VALUE_CHARS) {
      return `store value "${key}" is ${json.length} characters of JSON (limit ${MAX_STORE_VALUE_CHARS})`;
    }
    total += json.length;
  }
  if (total > MAX_STORE_TOTAL_CHARS) {
    return `store holds ${total} characters of JSON (limit ${MAX_STORE_TOTAL_CHARS})`;
  }
  return undefined;
}

/** 校验并追加快照条目；超限不写，返回说明。 */
export function commitStore(session: SessionAccess, entries: StoreSnapshot): string | undefined {
  const problem = validateStore(entries);
  if (problem !== undefined) return problem;
  const data: StoreEntryData = { entries };
  session.appendCustom(STORE_CUSTOM_TYPE, data);
  return undefined;
}
