/**
 * 会话文件版本兜底（设计 §1.2「v1 文件读取兜底（预留）」）。[B2]
 *
 * 当前格式版本 1。读入的首行必须是 `type: "session"` 的头：
 * - version 1 → 原样返回条目；
 * - 更高版本 → 拒绝（session_corrupt，提示升级 ama）；
 * - 缺头 / 头损坏 / 条目缺 id → 拒绝，不猜测、不重写文件。
 * 将来格式升级时在这里加「旧版本 → 当前」的内存迁移（文件只追加，不回写）。
 */

import { AmaError } from "../errors.js";
import { SESSION_FORMAT_VERSION } from "./types.js";
import type { SessionEntry, SessionHeader, SessionLine } from "./types.js";

export interface MigratedSession {
  header: SessionHeader;
  entries: SessionEntry[];
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
  rest.forEach((line, i) => {
    if (!isObject(line) || typeof line["id"] !== "string" || typeof line["type"] !== "string") {
      throw new AmaError("session_corrupt", `${file}:${i + 2}: malformed entry`);
    }
    if (line["type"] === "session") {
      throw new AmaError("session_corrupt", `${file}:${i + 2}: duplicate session header`);
    }
    entries.push(line as unknown as SessionEntry);
  });
  return { header: first as unknown as SessionHeader, entries };
}
