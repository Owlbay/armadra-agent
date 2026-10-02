/**
 * 编辑器的历史文件（设计 §12.4）：JSONL，每行一个 JSON 字符串，保留最近 `limit` 条。[B4]
 * 读写失败都不影响编辑（损坏的行跳过；写失败静默）。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadHistoryFile(path: string, limit = 500): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "string" && value !== "") entries.push(value);
    } catch {
      // 损坏的行跳过
    }
  }
  return entries.slice(-limit);
}

export function appendHistoryFile(path: string, entry: string, limit: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    const all = loadHistoryFile(path, Number.MAX_SAFE_INTEGER);
    if (all.length > limit * 2) {
      writeFileSync(
        path,
        all
          .slice(-limit)
          .map((e) => JSON.stringify(e) + "\n")
          .join(""),
      );
    }
  } catch {
    // 历史写失败不影响编辑
  }
}
