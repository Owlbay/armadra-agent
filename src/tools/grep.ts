/**
 * 内置正则搜索（设计 §5.2 grep）。[B3]
 *
 * - 遍历尊重 `.gitignore` / `.ignore`；跳过二进制（NUL 嗅探）与 > 2 MB 文件；每批并发 16 个文件；
 * - 文件按路径排序处理，输出确定；匹配行 `path:line: text`，上下文行 `path-line- text`，
 *   不相邻的组之间 `--`；匹配行截 500 字符；
 * - 匹配数到 limit（缺省 100）即停并提示；整体输出再按 50 KB 头截断。
 * - [S-A] `filesOnly`：只列命中文件（去重、按路径排序，每个文件命中一行即停），limit 按文件数计；
 *   给模型在大仓库里先缩范围（docs/search-plan.md §4.2）。
 */

import { readFile, stat } from "node:fs/promises";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";
import { walk } from "./ignore.js";
import { GlobMatcher } from "./glob.js";
import { isBinary } from "./read.js";
import { DEFAULT_MAX_BYTES, truncateHead, truncateLine } from "./truncate.js";

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
  filesOnly?: boolean;
}

export const DEFAULT_GREP_LIMIT = 100;
export const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const GREP_CONCURRENCY = 16;
const MAX_CONTEXT = 5;

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compilePattern(
  input: Pick<GrepInput, "pattern" | "ignoreCase" | "literal">,
): RegExp {
  const source = input.literal ? escapeRegExp(input.pattern) : input.pattern;
  return new RegExp(source, input.ignoreCase ? "i" : "");
}

interface FileHits {
  lines: string[];
  hits: number[];
}

async function searchFile(
  abs: string,
  regex: RegExp,
  firstOnly = false,
): Promise<FileHits | undefined> {
  try {
    const info = await stat(abs);
    if (!info.isFile() || info.size > GREP_MAX_FILE_BYTES) return undefined;
    const buf = await readFile(abs);
    if (isBinary(buf)) return undefined;
    const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i] as string)) continue;
      hits.push(i);
      if (firstOnly) break;
    }
    return hits.length > 0 ? { lines, hits } : undefined;
  } catch {
    return undefined;
  }
}

/** 一个文件的输出块；`budget` 是还允许输出的匹配数。 */
export function formatFileHits(
  shown: string,
  file: FileHits,
  context: number,
  budget: number,
): { text: string[]; used: number } {
  const hits = file.hits.slice(0, budget);
  const out: string[] = [];
  let lastPrinted = -1;
  const hitSet = new Set(hits);
  for (const hit of hits) {
    const from = Math.max(0, hit - context);
    const to = Math.min(file.lines.length - 1, hit + context);
    if (context > 0 && lastPrinted >= 0 && from > lastPrinted + 1) out.push("--");
    for (let i = Math.max(from, lastPrinted + 1); i <= to; i++) {
      const sep = hitSet.has(i) ? ":" : "-";
      out.push(`${shown}${sep}${i + 1}${sep} ${truncateLine(file.lines[i] ?? "")}`);
    }
    lastPrinted = Math.max(lastPrinted, to);
  }
  return { text: out, used: hits.length };
}

async function candidateFiles(
  root: string,
  isFile: boolean,
  glob: string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  if (isFile) return [root];
  const matcher = glob ? new GlobMatcher(glob) : undefined;
  const files: string[] = [];
  for await (const entry of walk(root, { signal })) {
    if (entry.isDir) continue;
    if (matcher && !matcher.matches(entry.rel)) continue;
    files.push(entry.abs);
  }
  return files;
}

export async function executeGrep(input: GrepInput, ctx: ToolContext): Promise<ToolResult> {
  if (typeof input.pattern !== "string" || input.pattern === "") {
    return { content: "pattern must be a non-empty string", isError: true };
  }
  let regex: RegExp;
  try {
    regex = compilePattern(input);
  } catch (err) {
    return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true };
  }
  const context = Math.min(MAX_CONTEXT, Math.max(0, Math.floor(input.context ?? 0)));
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    return { content: "limit must be an integer ≥ 1", isError: true };
  }
  const root = resolvePath(input.path ?? ".", ctx.cwd);
  let rootIsFile: boolean;
  try {
    rootIsFile = (await stat(root)).isFile();
  } catch {
    return { content: `Path not found: ${displayPath(root, ctx.cwd)}`, isError: true };
  }

  const files = await candidateFiles(root, rootIsFile, input.glob, ctx.signal);
  if (input.filesOnly === true) return grepFilesOnly(files, regex, limit, ctx);
  const blocks: string[] = [];
  let matches = 0;
  let matchedFiles = 0;
  let limited = false;
  outer: for (let i = 0; i < files.length; i += GREP_CONCURRENCY) {
    if (ctx.signal.aborted) return { content: "aborted by user", isError: true };
    const batch = files.slice(i, i + GREP_CONCURRENCY);
    const results = await Promise.all(batch.map((f) => searchFile(f, regex)));
    for (let j = 0; j < batch.length; j++) {
      const hits = results[j];
      if (!hits) continue;
      if (matches >= limit) {
        limited = true;
        break outer;
      }
      const shown = displayPath(batch[j] as string, ctx.cwd);
      const block = formatFileHits(shown, hits, context, limit - matches);
      blocks.push(block.text.join("\n"));
      matches += block.used;
      matchedFiles++;
      if (block.used < hits.hits.length) {
        limited = true;
        break outer;
      }
    }
  }
  if (matches === 0) return { content: "No matches found", details: { matches: 0, files: 0 } };
  const joined = blocks.join(context > 0 ? "\n--\n" : "\n");
  const cut = truncateHead(joined, {
    maxLines: Number.MAX_SAFE_INTEGER,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let content = cut.content;
  if (limited) {
    content += `\n\n[Stopped at ${limit} matches. Narrow the search or raise limit.]`;
  } else if (cut.truncated) {
    content += "\n\n[Output truncated at 50 KB. Narrow the search.]";
  }
  return {
    content,
    details: { matches, files: matchedFiles, limited, truncated: cut.truncated },
  };
}

/** [S-A] filesOnly：命中文件的显示路径，去重并按路径排序；limit 按文件数计。 */
async function grepFilesOnly(
  files: readonly string[],
  regex: RegExp,
  limit: number,
  ctx: ToolContext,
): Promise<ToolResult> {
  const sorted = [...new Set(files)].sort();
  const shown: string[] = [];
  let limited = false;
  outer: for (let i = 0; i < sorted.length; i += GREP_CONCURRENCY) {
    if (ctx.signal.aborted) return { content: "aborted by user", isError: true };
    const batch = sorted.slice(i, i + GREP_CONCURRENCY);
    const results = await Promise.all(batch.map((f) => searchFile(f, regex, true)));
    for (let j = 0; j < batch.length; j++) {
      if (!results[j]) continue;
      if (shown.length >= limit) {
        limited = true;
        break outer;
      }
      shown.push(displayPath(batch[j] as string, ctx.cwd));
    }
  }
  if (shown.length === 0) {
    return { content: "No matches found", details: { matches: 0, files: 0, filesOnly: true } };
  }
  const unique = [...new Set(shown)].sort();
  let content = unique.join("\n");
  if (limited) content += `\n\n[Stopped at ${limit} files. Narrow the search or raise limit.]`;
  return { content, details: { files: unique.length, filesOnly: true, limited } };
}

export function createGrepTool(): ToolDefinition<GrepInput> {
  return {
    name: "grep",
    label: "Grep",
    description:
      "Use to find where a symbol or text appears (JS regex). Skips ignored, binary, >2 MB " +
      "files. Output `path:line: text`; filesOnly lists matching files.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "File or dir" },
        glob: { type: "string", description: "e.g. *.ts" },
        ignoreCase: { type: "boolean" },
        literal: { type: "boolean" },
        context: { type: "integer", description: "0-5 lines" },
        limit: { type: "integer", description: `Default ${DEFAULT_GREP_LIMIT}` },
        filesOnly: { type: "boolean" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    annotations: { readOnly: true },
    promptSnippet: "grep: search file contents",
    execute: executeGrep,
  };
}
