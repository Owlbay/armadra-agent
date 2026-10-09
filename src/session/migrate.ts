/**
 * 会话文件版本兜底（设计 §1.2「v1 文件读取兜底（预留）」）。[B2]
 *
 * 当前格式版本 1。读入的首行必须是 `type: "session"` 的头：
 * - version 1 → 原样返回条目；
 * - 更高版本 → 拒绝（session_corrupt，提示升级 ama）；
 * - 缺头 / 头损坏 / 条目缺 id → 拒绝，不猜测、不重写文件。
 * - [W3-C1b] `leaf` 行（`/tree` 位置，第三波 A7）不是条目：不进 entries；最后一条 leaf 行若在
 *   最后一条条目之后，作为 `leafId` 返回（之后又追加了条目则作废）。id 须为字符串或 null。
 * 将来格式升级时在这里加「旧版本 → 当前」的内存迁移（文件只追加，不回写）；`list.ts` 不经本函数、
 * 自己按 v1 规则流式统计，升级格式时要同时改它（docs/memory-plan.md R6）。
 */

import { AmaError } from "../errors.js";
import { SESSION_FORMAT_VERSION } from "./types.js";
import type { SessionEntry, SessionHeader, SessionLine } from "./types.js";

export interface MigratedSession {
  header: SessionHeader;
  entries: SessionEntry[];
  /** 晚于最后一条条目的 leaf 行给出的叶子；没有则缺省（叶子 = 最后一条条目）。 */
  leafId?: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function migrateSessionLines(
  lines: readonly SessionLine[],
  file = "<memory>",
): MigratedSession {
  const [first, ...rest] = lines;
  if (!isObject(first) || first["type"] !== "session") {
    throw new AmaError("session_corrupt", `${file}: missing session header`);
  }
  const version = first["version"];
  if (version !== SESSION_FORMAT_VERSION) {
    throw new AmaError(
      "session_corrupt",
      `${file}: unsupported session format version ${String(version)} (this ama reads version ${SESSION_FORMAT_VERSION})`,
    );
  }
  if (typeof first["id"] !== "string" || typeof first["cwd"] !== "string") {
    throw new AmaError("session_corrupt", `${file}: malformed session header`);
  }
  const entries: SessionEntry[] = [];
  let leafId: string | null | undefined;
  rest.forEach((line, i) => {
    if (isObject(line) && line["type"] === "leaf") {
      const id = line["id"];
      if (id !== null && typeof id !== "string") {
        throw new AmaError("session_corrupt", `${file}:${i + 2}: malformed leaf line`);
      }
      leafId = id;
      return;
    }
    if (!isObject(line) || typeof line["id"] !== "string" || typeof line["type"] !== "string") {
      throw new AmaError("session_corrupt", `${file}:${i + 2}: malformed entry`);
    }
    if (line["type"] === "session") {
      throw new AmaError("session_corrupt", `${file}:${i + 2}: duplicate session header`);
    }
    entries.push(line as unknown as SessionEntry);
    leafId = undefined;
  });
  const result: MigratedSession = { header: first as unknown as SessionHeader, entries };
  if (leafId !== undefined) result.leafId = leafId;
  return result;
}
