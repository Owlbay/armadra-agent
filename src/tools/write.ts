/**
 * `write` 工具（设计 §5.2）。[B3]
 *
 * 整文件覆盖、自动建父目录；文件已存在且不在 `ctx.readFiles` → 错误「先 read」；若原文件有 BOM
 * 或 CRLF，写回时保留（新内容自带 BOM / CRLF 时不重复加）。`details: { bytes, created }`。
 * `fileChange`（[ACP-C] D6）：改前 / 改后的磁盘原文，新文件 `oldText: null`；任一侧超过上限不填。
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";
import { withFileMutex } from "./file-mutex.js";
import { beforeWrite, fileChangeOf } from "./edit.js";
import {
  BOM,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  splitBom,
} from "./edit-fuzzy.js";

export interface WriteInput {
  path: string;
  content: string;
}

export interface WriteDetails {
  path: string;
  bytes: number;
  created: boolean;
}

async function exists(path: string): Promise<"file" | "dir" | false> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? "dir" : "file";
  } catch {
    return false;
  }
}

/** 按原文件的 BOM / 换行风格调整新内容。 */
export function conformToOriginal(original: string, content: string): string {
  const { bom, text } = splitBom(original);
  const incoming = splitBom(content);
  let body = incoming.text;
  if (detectLineEnding(text) === "\r\n" && text.includes("\n")) {
    body = restoreLineEndings(normalizeToLF(body), "\r\n");
  }
  return (bom !== "" || incoming.bom !== "" ? BOM : "") + body;
}

/** 首个不同的行（从 1 起，按 LF 归一后比较；内容不变时为末行）；新文件为 1。 */
function firstLineChanged(original: string | null, output: string): number {
  if (original === null) return 1;
  const a = normalizeToLF(splitBom(original).text).split("\n");
  const b = normalizeToLF(splitBom(output).text).split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return Math.min(i + 1, b.length);
}

export async function executeWrite(input: WriteInput, ctx: ToolContext): Promise<ToolResult> {
  const abs = resolvePath(input.path, ctx.cwd);
  const shown = displayPath(abs, ctx.cwd);
  if (typeof input.content !== "string") {
    return { content: "content must be a string", isError: true };
  }
  return withFileMutex(abs, async () => {
    const state = await exists(abs);
    if (state === "dir") return { content: `${shown} is a directory`, isError: true };
    let output = input.content;
    let original: string | null = null;
    if (state === "file") {
      if (!ctx.readFiles.has(abs)) {
        return {
          content: `${shown} already exists. Read it with the read tool before overwriting it.`,
          isError: true,
        };
      }
      original = await readFile(abs, "utf8");
      output = conformToOriginal(original, input.content);
    }
    await beforeWrite(ctx, abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, output, "utf8");
    ctx.checkpoint?.afterWrite(abs, output);
    ctx.markRead(abs);
    const details: WriteDetails = {
      path: abs,
      bytes: Buffer.byteLength(output, "utf8"),
      created: state === false,
    };
    const verb = details.created ? "Created" : "Overwrote";
    const result: ToolResult = { content: `${verb} ${shown} (${details.bytes} bytes)`, details };
    const fileChange = fileChangeOf(abs, original, output, firstLineChanged(original, output));
    if (fileChange !== undefined) result.fileChange = fileChange;
    return result;
  });
}

export function createWriteTool(): ToolDefinition<WriteInput> {
  return {
    name: "write",
    label: "Write",
    description:
      "Write a file, replacing its entire content; parent directories are created. " +
      "An existing file must be read first. Prefer the edit tool for partial changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to cwd" },
        content: { type: "string", description: "Full new file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    permission: "write",
    executionMode: "sequential",
    annotations: { destructive: true },
    promptSnippet: "write: create or overwrite a whole file (read existing files first)",
    execute: executeWrite,
  };
}
