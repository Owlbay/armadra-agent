/**
 * 会话列表（`SessionManager.list` 的实现）。[M-C] 按块逐行读（docs/history/memory-plan.md D6、§2.4）：
 * 只解析头、第一条条目、`leaf` / `session_info` 行、要取 `firstPrompt` 的那一条 user 消息与末行；
 * 其余 ama 写的行只看行首的 type / role（`lineTypeOf`），不生成全文字符串、不留条目对象。
 *
 * 口径与「`migrateSessionLines(readSessionLines(file).lines)` 再统计」一致：空行跳过、末尾半行忽略、
 * 头必须是 `type: "session"` / `version === SESSION_FORMAT_VERSION` / id 与 cwd 为字符串、`leaf` 行不算
 * 条目、重复的头与解析失败的中间行让整个文件跳过。差别只有一处：不解析的 ama 行不再逐条检查
 * `id`（ama 写入的条目总有 id）；行尾不是 `}` 的（写到一半又被追加的坏行）仍会退回完整解析。
 * 不经 `migrateSessionLines`——格式升到 v2 时要同时改这里（R6，见 migrate.ts）。
 */

import { statSync } from "node:fs";
import { forEachLineSync, lineTypeOf } from "./line-reader.js";
import { isBlankLine, isSubagentSession, listSessionFiles } from "./store.js";
import { SESSION_FORMAT_VERSION, type SessionHeader, type SessionListItem } from "./types.js";

type Json = Record<string, unknown>;

class SkipFile extends Error {}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endsWithBrace(line: Buffer): boolean {
  for (let i = line.length - 1; i >= 0; i--) {
    const byte = line[i] as number;
    if (byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)) continue;
    return byte === 0x7d;
  }
  return false;
}

function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[])
    .map((block) => (block.type === "text" ? (block.text as string) : ""))
    .join("");
}

interface Tally {
  header?: SessionHeader;
  first?: unknown;
  hasFirst: boolean;
  name?: string;
  firstPrompt?: string;
  messageCount: number;
}

/** 统计一条已解析的行（头之后）；不合 v1 规则时抛 SkipFile。 */
function tallyParsed(tally: Tally, line: unknown): void {
  if (isObject(line) && line["type"] === "leaf") {
    const id = line["id"];
    if (id !== null && typeof id !== "string") throw new SkipFile();
    return;
  }
  if (!isObject(line) || typeof line["id"] !== "string" || typeof line["type"] !== "string") {
    throw new SkipFile();
  }
  if (line["type"] === "session") throw new SkipFile();
  if (!tally.hasFirst) {
    tally.hasFirst = true;
    tally.first = line;
  }
  if (line["type"] === "session_info" && line["name"] !== undefined) {
    tally.name = line["name"] as string;
  }
  if (line["type"] !== "message") return;
  const message = line["message"] as { role: string; content: unknown };
  if (message.role === "system") return;
  tally.messageCount++;
  if (tally.firstPrompt === undefined && message.role === "user") {
    tally.firstPrompt = promptText(message.content);
  }
}

function parseHeader(line: unknown): SessionHeader {
  if (!isObject(line) || line["type"] !== "session") throw new SkipFile();
  if (line["version"] !== SESSION_FORMAT_VERSION) throw new SkipFile();
  if (typeof line["id"] !== "string" || typeof line["cwd"] !== "string") throw new SkipFile();
  return line as unknown as SessionHeader;
}

/** 不解析就能统计的 ama 行：已过第一条条目、类型确定、行尾完整，且不需要读出内容。 */
function tallyByType(tally: Tally, line: Buffer, firstPromptTaken: boolean): boolean {
  if (!tally.hasFirst || !endsWithBrace(line)) return false;
  const kind = lineTypeOf(line);
  if (kind === undefined) return false;
  if (kind.type === "leaf" || kind.type === "session_info" || kind.type === "session") return false;
  if (kind.type !== "message") return true;
  if (kind.role === undefined) return false;
  if (kind.role === "system") return true;
  if (kind.role === "user" && !firstPromptTaken) return false;
  tally.messageCount++;
  return true;
}

function tallyFile(file: string): Tally {
  const tally: Tally = { hasFirst: false, messageCount: 0 };
  forEachLineSync(file, (buf, _index, last) => {
    if (isBlankLine(buf)) return;
    if (tally.header !== undefined && !last) {
      if (tallyByType(tally, buf, tally.firstPrompt !== undefined)) return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      if (last) return false; // 末尾半行：与 readSessionLines 一样忽略
      throw new SkipFile();
    }
    if (tally.header === undefined) tally.header = parseHeader(parsed);
    else tallyParsed(tally, parsed);
  });
  return tally;
}

/** 只读列出目录下的会话（最新在前）；损坏的文件跳过。 */
export function listSessionItems(dir: string): SessionListItem[] {
  const items: SessionListItem[] = [];
  for (const file of listSessionFiles(dir)) {
    try {
      const { header, first, name, firstPrompt, messageCount } = tallyFile(file);
      if (header === undefined) continue;
      const item: SessionListItem = {
        id: header.id,
        file,
        cwd: header.cwd,
        createdAt: header.timestamp,
        modifiedAt: statSync(file).mtime.toISOString(),
        messageCount,
      };
      if (name !== undefined) item.name = name;
      if (isSubagentSession(header, first)) item.subagent = true;
      if (firstPrompt !== undefined) item.firstPrompt = firstPrompt.slice(0, 200);
      items.push(item);
    } catch {
      // 损坏 / 不可读：列表里跳过（sessions show 会给出具体错误）
    }
  }
  return items;
}
