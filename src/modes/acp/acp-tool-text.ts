/**
 * `ama --mode acp` 工具调用的展示字段：title / kind / locations、结果文本（前 4 KB）与 diff 内容。
 * [ACP-C] 从 acp-events.ts 拆出（docs/history/acp-plan.md §2.3、D5、D6）。
 *
 * - codemode 内层调用（带 parentToolCallId）的 title 加前缀 `acp.tools.codemodePrefix`；
 * - `tool_execution_end` 的 `content` = `[diff?, text]`：diff 来自 `ToolResult.fileChange`（edit / write
 *   填，超过单侧上限不填），text 为结果前 4 KB；`locations[].line` = `fileChange.firstChangedLine`。
 */

import { isAbsolute, resolve } from "node:path";
import type {
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolKind,
} from "../../drivers/acp/types.js";
import { oneLine } from "../../drivers/turn.js";
import type { ContentBlock } from "../../ai/types.js";
import type { ToolResult } from "../../tools/types.js";
import { msg } from "../../i18n/index.js";

export const TOOL_OUTPUT_LIMIT = 4 * 1024;

const KINDS: Record<string, AcpToolKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "execute",
  grep: "search",
  glob: "search",
  ls: "search",
  find: "search",
  web_fetch: "fetch",
  web_search: "fetch",
  todo: "think",
};

export function toolKind(name: string): AcpToolKind {
  return KINDS[name] ?? "other";
}

function argOf(args: unknown, ...keys: string[]): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** 工具调用标题：`<工具名>: <命令 / 路径 / 模式>`；`nested` 为 codemode 内层调用时加前缀。 */
export function toolTitle(name: string, args: unknown, nested = false): string {
  const detail =
    argOf(args, "command") ??
    argOf(args, "path", "file_path", "filePath") ??
    argOf(args, "pattern", "query", "url", "prompt");
  const title = detail === undefined ? name : `${name}: ${oneLine(detail, 100)}`;
  return nested ? msg().acp.tools.codemodePrefix(title) : title;
}

export function toolLocations(args: unknown, cwd: string): AcpToolCallLocation[] | undefined {
  const path = argOf(args, "path", "file_path", "filePath");
  if (path === undefined) return undefined;
  return [{ path: isAbsolute(path) ? path : resolve(cwd, path) }];
}

/** 工具结果的前 {@link TOOL_OUTPUT_LIMIT} 字符（超出附截断说明）；非文本块写成 `[type]`。 */
export function resultText(content: string | readonly ContentBlock[]): string {
  const text =
    typeof content === "string"
      ? content
      : content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
  return text.length > TOOL_OUTPUT_LIMIT
    ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n${msg().acp.tools.truncated(text.length)}`
    : text;
}

/** `tool_execution_end` 的 content 与 locations：`[diff?, text]`，有 fileChange 时位置带首个改动行。 */
export function resultContent(result: ToolResult): {
  content: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
} {
  const text: AcpToolCallContent = {
    type: "content",
    content: { type: "text", text: resultText(result.content) },
  };
  const change = result.fileChange;
  if (change === undefined) return { content: [text] };
  return {
    content: [
      { type: "diff", path: change.path, oldText: change.oldText, newText: change.newText },
      text,
    ],
    locations: [
      {
        path: change.path,
        ...(change.firstChangedLine !== undefined ? { line: change.firstChangedLine } : {}),
      },
    ],
  };
}
