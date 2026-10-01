/**
 * `ls` 工具（设计 §5.2）。[B3]
 *
 * 目录项按名字排序（目录与文件混排，与 `ls` 一致）；目录写 `name/`，文件附大小，符号链接写
 * `name -> target`；含点文件，不过滤 ignore；缺省上限 500。
 */

import { lstat, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";
import { formatSize } from "./truncate.js";

export interface LsInput {
  path?: string;
  limit?: number;
}

export const DEFAULT_LS_LIMIT = 500;

export interface LsEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size?: number;
  target?: string;
}

async function describe(dir: string, name: string): Promise<LsEntry> {
  const abs = join(dir, name);
  try {
    const info = await lstat(abs);
    if (info.isSymbolicLink()) {
      let target = "?";
      try {
        target = await readlink(abs);
      } catch {
        // 保留 ?
      }
      let pointsToDir = false;
      try {
        pointsToDir = (await stat(abs)).isDirectory();
      } catch {
        // 悬空链接
      }
      return { name: pointsToDir ? `${name}/` : name, type: "symlink", target };
    }
    if (info.isDirectory()) return { name: `${name}/`, type: "dir" };
    if (info.isFile()) return { name, type: "file", size: info.size };
    return { name, type: "other" };
  } catch {
    return { name, type: "other" };
  }
}

export function formatEntry(entry: LsEntry): string {
  if (entry.type === "symlink") return `${entry.name} -> ${entry.target ?? "?"}`;
  if (entry.type === "file") return `${entry.name}  (${formatSize(entry.size ?? 0)})`;
  return entry.name;
}

export async function executeLs(input: LsInput, ctx: ToolContext): Promise<ToolResult> {
  const limit = input.limit ?? DEFAULT_LS_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    return { content: "limit must be an integer ≥ 1", isError: true };
  }
  const dir = resolvePath(input.path ?? ".", ctx.cwd);
  const shown = displayPath(dir, ctx.cwd);
  let names: string[];
  try {
    if (!(await stat(dir)).isDirectory())
      return { content: `${shown} is not a directory`, isError: true };
    names = await readdir(dir);
  } catch {
    return { content: `Directory not found: ${shown}`, isError: true };
  }
  names.sort((a, b) => a.localeCompare(b, "en"));
  if (names.length === 0) return { content: `(${shown} is empty)`, details: { count: 0 } };
  const entries = await Promise.all(names.slice(0, limit).map((n) => describe(dir, n)));
  let content = entries.map(formatEntry).join("\n");
  if (names.length > limit) {
    content += `\n\n[${names.length} entries; showing the first ${limit}. Raise limit to see more.]`;
  }
  return { content, details: { count: names.length, entries } };
}

export function createLsTool(): ToolDefinition<LsInput> {
  return {
    name: "ls",
    label: "List",
    description:
      "List a directory: subdirectories end with `/`, files show their size, symlinks show their " +
      `target. Includes dotfiles. Default limit ${DEFAULT_LS_LIMIT}.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory (default: cwd)" },
        limit: { type: "integer", description: `Maximum entries (default ${DEFAULT_LS_LIMIT})` },
      },
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    annotations: { readOnly: true },
    promptSnippet: "ls: list directory contents",
    execute: executeLs,
  };
}
