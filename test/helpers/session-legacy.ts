/**
 * 会话文件流式读取（docs/memory-plan.md D6、[M-C]）的比对参照：改造前的整读实现原样保留在这里，
 * 新实现的测试拿它对 test/fixtures 下全部 `.jsonl` 做口径比对。只给测试用。
 */

import { readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AmaError } from "../../src/errors.js";
import { migrateSessionLines } from "../../src/session/migrate.js";
import { isSubagentSession, listSessionFiles, type ReadResult } from "../../src/session/store.js";
import type { SessionLine, SessionListItem } from "../../src/session/types.js";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** test/fixtures 下全部 .jsonl（trace、会话口径语料，以及 rpc / acp / drivers 等非会话文件）。 */
export function fixtureFiles(root = FIXTURES): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) out.push(...fixtureFiles(full));
    else if (name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** 旧 `readSessionLines`：readFileSync 全文 + split。 */
export function legacyReadSessionLines(
  file: string,
  options: { repair?: boolean } = {},
): ReadResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new AmaError("session_not_found", `cannot read session file ${file}`, { cause: error });
  }
  const rawLines = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) rawLines.pop();
  const lines: SessionLine[] = [];
  let repairedTail = false;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = (rawLines[i] ?? "").replace(/\r$/, "");
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as SessionLine);
    } catch (error) {
      const isLast = i === rawLines.length - 1;
      if (isLast && !endsWithNewline) {
        repairedTail = true;
        if (options.repair === true) {
          const keep = Buffer.byteLength(rawLines.slice(0, i).join("\n"), "utf8") + (i > 0 ? 1 : 0);
          truncateSync(file, keep);
        }
        break;
      }
      throw new AmaError("session_corrupt", `${file}:${i + 1}: invalid JSON line`, {
        cause: error,
      });
    }
  }
  if (!repairedTail && !endsWithNewline && text.length > 0 && options.repair === true) {
    writeFileSync(file, "\n", { flag: "a" });
  }
  return { lines, repairedTail };
}

/** 旧 `forEachLine`（scan.ts）：readFileSync 全文后按 `\n` 切。 */
export function legacyForEachLine(
  file: string,
  visit: (line: string, index: number, last: boolean) => boolean | void,
): void {
  const text = readFileSync(file, "utf8");
  let start = 0;
  let index = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    const last = end === -1;
    if (last) end = text.length;
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    start = end + 1;
    if (line.trim() === "") continue;
    if (visit(line, index++, last) === false) return;
  }
}

/** 旧 `listSessionItems`：整读 + migrateSessionLines 后统计。 */
export function legacyListSessionItems(dir: string): SessionListItem[] {
  const items: SessionListItem[] = [];
  for (const file of listSessionFiles(dir)) {
    try {
      const { header, entries } = migrateSessionLines(legacyReadSessionLines(file).lines, file);
      let name: string | undefined;
      let firstPrompt: string | undefined;
      let messageCount = 0;
      for (const entry of entries) {
        if (entry.type === "session_info" && entry.name !== undefined) name = entry.name;
        if (entry.type !== "message" || entry.message.role === "system") continue;
        messageCount++;
        if (firstPrompt === undefined && entry.message.role === "user") {
          const { content } = entry.message;
          firstPrompt =
            typeof content === "string"
              ? content
              : content.map((block) => (block.type === "text" ? block.text : "")).join("");
        }
      }
      const item: SessionListItem = {
        id: header.id,
        file,
        cwd: header.cwd,
        createdAt: header.timestamp,
        modifiedAt: statSync(file).mtime.toISOString(),
        messageCount,
      };
      if (name !== undefined) item.name = name;
      if (isSubagentSession(header, entries[0])) item.subagent = true;
      if (firstPrompt !== undefined) item.firstPrompt = firstPrompt.slice(0, 200);
      items.push(item);
    } catch {
      // 损坏 / 不可读：跳过
    }
  }
  return items;
}
