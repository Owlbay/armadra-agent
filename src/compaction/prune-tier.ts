/**
 * 档一裁剪（设计 §9「档一」）：无模型调用。[B2]
 *
 * 触发：`contextTokens > 0.7 × (contextWindow − reserveTokens)`。
 * 范围：最近两个用户回合之前、内容 > 2 KiB 的 toolResult。
 * 动作：返回 `context_edit{reason:"prune", replacement:"[已裁剪 …全文 path]"}` 计划；有 outputDir 时
 * 把全文写到 `<outputDir>/<toolCallId>.txt`（已存在则不覆盖），模型可用 read 取回。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock } from "../ai/types.js";
import type { ContextItem } from "../session/projection.js";

export const PRUNE_THRESHOLD_RATIO = 0.7;
export const PRUNE_MIN_BYTES = 2048;
export const PRUNE_KEEP_USER_TURNS = 2;

export interface PrunePlanItem {
  targetId: string;
  replacement: string;
  toolCallId: string;
  originalBytes: number;
  fullTextPath?: string;
}

export interface PruneOptions {
  keepUserTurns?: number;
  minBytes?: number;
  /** 全文落盘目录；undefined 时不落盘（内存会话）。 */
  outputDir?: string | undefined;
}

export function pruneThreshold(contextWindow: number, reserveTokens: number): number {
  return PRUNE_THRESHOLD_RATIO * Math.max(0, contextWindow - reserveTokens);
}

export function shouldPrune(tokens: number, contextWindow: number, reserveTokens: number): boolean {
  return tokens > pruneThreshold(contextWindow, reserveTokens);
}

export function contentToText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
    .join("\n");
}

function safeFileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "tool";
}

/** 计算裁剪计划（并按需落盘全文）；返回空数组表示无可裁剪项。 */
export function planPrune(
  items: readonly ContextItem[],
  options: PruneOptions = {},
): PrunePlanItem[] {
  const keepTurns = options.keepUserTurns ?? PRUNE_KEEP_USER_TURNS;
  const minBytes = options.minBytes ?? PRUNE_MIN_BYTES;

  let boundary = items.length;
  let seen = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.message.role !== "user") continue;
    seen++;
    if (seen >= keepTurns) {
      boundary = i;
      break;
    }
  }
  if (seen < keepTurns) return [];

  const plan: PrunePlanItem[] = [];
  for (const item of items.slice(0, boundary)) {
    const { message, entry } = item;
    if (message.role !== "toolResult" || entry.type !== "message") continue;
    const text = contentToText(message.content);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= minBytes) continue;
    let fullTextPath: string | undefined;
    if (options.outputDir !== undefined) {
      fullTextPath = join(options.outputDir, `${safeFileStem(message.toolCallId)}.txt`);
      try {
        if (!existsSync(fullTextPath)) {
          mkdirSync(options.outputDir, { recursive: true });
          writeFileSync(fullTextPath, text, "utf8");
        }
      } catch {
        fullTextPath = undefined;
      }
    }
    const replacement =
      fullTextPath === undefined
        ? `[已裁剪：${message.toolName} 的结果原有 ${bytes} 字节，全文不可用]`
        : `[已裁剪：${message.toolName} 的结果原有 ${bytes} 字节，全文 ${fullTextPath}]`;
    const planned: PrunePlanItem = {
      targetId: entry.id,
      replacement,
      toolCallId: message.toolCallId,
      originalBytes: bytes,
    };
    if (fullTextPath !== undefined) planned.fullTextPath = fullTextPath;
    plan.push(planned);
  }
  return plan;
}
