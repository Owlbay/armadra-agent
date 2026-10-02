/**
 * 会话复用：用户消息编号与 `--from <id>[#n]`。[W4-D]
 *
 * - 编号 = 文件里第几条 `role: "user"` 的消息（1 起，含 steer / followUp / host 注入），与分支无关、
 *   只追加所以稳定；`ama sessions show` 列出，`ama sessions search` 的命中也给出同样的编号。
 * - `--from <id>`（不带 `#n`）取文件里最后一条用户消息。
 * - 取出的是那条消息的文本（多个文本块用空行连接）与图片块。
 */

import type { ContentBlock, ImageBlock } from "../ai/types.js";
import { AmaError } from "../errors.js";
import { findSessionFileReadOnly, readSessionReadOnly } from "./scan.js";
import type { SessionEntry } from "./types.js";
import { msg } from "../i18n/index.js";

export interface NumberedUserMessage {
  n: number;
  entryId: string;
  timestamp: string;
  text: string;
  images: ImageBlock[];
  origin?: string;
}

/** 内容 → 纯文本（文本块用空行连接；不含图片）。 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n\n");
}

export function contentImages(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).filter(
    (block): block is ImageBlock =>
      typeof block === "object" &&
      block !== null &&
      block.type === "image" &&
      typeof block.data === "string",
  );
}

export function numberUserMessages(entries: readonly SessionEntry[]): NumberedUserMessage[] {
  const out: NumberedUserMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const message = entry.message as { content: unknown; origin?: unknown };
    const item: NumberedUserMessage = {
      n: out.length + 1,
      entryId: entry.id,
      timestamp: entry.timestamp,
      text: contentText(message.content),
      images: contentImages(message.content),
    };
    if (typeof message.origin === "string") item.origin = message.origin;
    out.push(item);
  }
  return out;
}

/** `abc123#4` → `{ id: "abc123", n: 4 }`；`abc123` → `{ id }`。 */
export function parseFromSpec(spec: string): { id: string; n?: number } {
  const at = spec.lastIndexOf("#");
  if (at < 0) {
    if (spec.trim() === "")
      throw new AmaError("invalid_arguments", msg().session.lookup.fromNeedsId, { exitCode: 2 });
    return { id: spec };
  }
  const id = spec.slice(0, at);
  const raw = spec.slice(at + 1);
  const n = Number(raw);
  if (id === "" || !/^\d+$/.test(raw) || n < 1) {
    throw new AmaError("invalid_arguments", msg().session.lookup.fromInvalid(spec), {
      exitCode: 2,
    });
  }
  return { id, n };
}

export interface FromMessage extends NumberedUserMessage {
  sessionId: string;
  file: string;
}

/** 在会话目录里找 `--from` 指向的用户消息；找不到会话 → session_not_found，编号越界 → 用法错误。 */
export function resolveFromMessage(root: string, spec: string, cwd?: string): FromMessage {
  const { id, n } = parseFromSpec(spec);
  const file = findSessionFileReadOnly(root, id, cwd);
  const session = readSessionReadOnly(file);
  const messages = numberUserMessages(session.entries);
  if (messages.length === 0) {
    throw new AmaError(
      "invalid_arguments",
      msg().session.lookup.noUserMessages(session.header.id),
      {
        exitCode: 2,
      },
    );
  }
  const picked = n === undefined ? messages.at(-1) : messages[n - 1];
  if (picked === undefined) {
    throw new AmaError(
      "invalid_arguments",
      msg().session.lookup.tooFewMessages(session.header.id, messages.length, n as number),
      { exitCode: 2 },
    );
  }
  return { ...picked, sessionId: session.header.id, file };
}
