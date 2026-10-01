/**
 * 被摘要段的文本序列化（设计 §9「模板」）与文件操作累计。[B2]
 *
 * 形状：`[User]: … / [Assistant thinking]: … / [Assistant]: … / [Assistant tool calls]: read(path="…") /
 * [Tool result]: …`——写成记录而非对话，避免摘要模型把它当成要续写的对话。工具结果截 2 000 字符。
 */

import type { FileOpsDetails } from "../session/types.js";
import type { AgentMessage } from "../session/types.js";
import { contentToText } from "./prune-tier.js";

export const TOOL_RESULT_SERIALIZE_LIMIT = 2000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [截断，原 ${text.length} 字符]`;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => {
      const text =
        typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? "");
      return `${key}=${truncate(text, 300)}`;
    })
    .join(", ");
}

export function serializeMessage(message: AgentMessage): string {
  switch (message.role) {
    case "system":
      return "";
    case "user":
      return `[User]: ${contentToText(message.content)}`;
    case "custom":
      return `[Context ${message.customType}]: ${contentToText(message.content)}`;
    case "compactionSummary":
      return `[Earlier summary]: ${message.summary}`;
    case "branchSummary":
      return `[Branch summary]: ${message.summary}`;
    case "toolResult":
      return `[Tool result${message.isError ? " (error)" : ""} ${message.toolName}]: ${truncate(
        contentToText(message.content),
        TOOL_RESULT_SERIALIZE_LIMIT,
      )}`;
    case "assistant": {
      const parts: string[] = [];
      const thinking = message.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking)
        .join("\n")
        .trim();
      if (thinking !== "") parts.push(`[Assistant thinking]: ${thinking}`);
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text !== "") parts.push(`[Assistant]: ${text}`);
      const calls = message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => `${block.name}(${formatArgs(block.arguments)})`);
      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
      if (message.stopReason === "error" && message.errorMessage !== undefined) {
        parts.push(`[Assistant error]: ${message.errorMessage}`);
      }
      return parts.join("\n");
    }
  }
}

export function serializeConversation(messages: readonly AgentMessage[]): string {
  return messages
    .map(serializeMessage)
    .filter((text) => text !== "")
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// 文件操作
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export interface FileOps {
  read: Set<string>;
  modified: Set<string>;
}

export function createFileOps(previous?: FileOpsDetails): FileOps {
  return {
    read: new Set(previous?.readFiles ?? []),
    modified: new Set(previous?.modifiedFiles ?? []),
  };
}

export function collectFileOps(messages: readonly AgentMessage[], ops: FileOps): FileOps {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const path = block.arguments["path"];
      if (typeof path !== "string" || path === "") continue;
      if (READ_TOOLS.has(block.name)) ops.read.add(path);
      else if (WRITE_TOOLS.has(block.name)) ops.modified.add(path);
    }
  }
  return ops;
}

/** 只读过、没改过的进 readFiles；改过的进 modifiedFiles。 */
export function fileOpsDetails(ops: FileOps): FileOpsDetails {
  return {
    readFiles: [...ops.read].filter((path) => !ops.modified.has(path)).sort(),
    modifiedFiles: [...ops.modified].sort(),
  };
}

export function formatFileOps(details: FileOpsDetails): string {
  const parts: string[] = [];
  if (details.readFiles.length > 0) {
    parts.push(`<read-files>\n${details.readFiles.join("\n")}\n</read-files>`);
  }
  if (details.modifiedFiles.length > 0) {
    parts.push(`<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return parts.join("\n\n");
}
