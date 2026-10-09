/**
 * 会话列表（`SessionManager.list` 的实现）。[M-C0] 函数体原样从 manager.ts 搬来，行为不变；
 * [M-C] 改为按行流式读取（docs/memory-plan.md §2.4），届时不再经 `migrateSessionLines`——
 * 格式升到 v2 时要同时改这里（R6）。
 */

import { statSync } from "node:fs";
import { migrateSessionLines } from "./migrate.js";
import { isSubagentSession, listSessionFiles, readSessionLines } from "./store.js";
import type { SessionListItem } from "./types.js";

/** 只读列出目录下的会话（最新在前）；损坏的文件跳过。 */
export function listSessionItems(dir: string): SessionListItem[] {
  const items: SessionListItem[] = [];
  for (const file of listSessionFiles(dir)) {
    try {
      const { header, entries } = migrateSessionLines(readSessionLines(file).lines, file);
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
      // 损坏 / 不可读：列表里跳过（sessions show 会给出具体错误）
    }
  }
  return items;
}
