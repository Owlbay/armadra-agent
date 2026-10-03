/**
 * 内置 glob（设计 §5.2 glob）。[B3]
 *
 * 语法：`*`（不跨 `/`）、`?`、`**`（零或多段）、`[abc]` / `[a-z]` / `[!x]`、`{a,b}`（可嵌套）、`\` 转义；
 * 以 `!` 开头的模式是排除。不含 `/` 的模式匹配**文件名**（任意深度），含 `/` 的匹配相对搜索根的
 * 路径。点文件同样参与匹配（`.git` 由遍历层排除）。Windows 上大小写不敏感。
 *
 * 工具：遍历尊重 `.gitignore` / `.ignore`，按 mtime 倒序，缺省上限 1000。
 */

import { stat } from "node:fs/promises";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";
import { walk } from "./ignore.js";

const REGEX_SPECIAL = /[.+^${}()|[\]\\*?]/;

function escapeChar(ch: string): string {
  return REGEX_SPECIAL.test(ch) || ch === "/" ? `\\${ch}` : ch;
}

/** 从 `start`（指向 `[`）解析字符类，返回 [正则片段, 结束下标]；不闭合返回 undefined。 */
function parseClass(p: string, start: number): [string, number] | undefined {
  let i = start + 1;
  let negate = false;
  if (p[i] === "!" || p[i] === "^") {
    negate = true;
    i++;
  }
  let body = "";
  let first = true;
  while (i < p.length) {
    const ch = p[i] as string;
    if (ch === "]" && !first) {
      return [`[${negate ? "^" : ""}${body}${negate ? "/" : ""}]`, i];
    }
    if (ch === "\\" && i + 1 < p.length) {
      body += `\\${p[i + 1]}`;
      i += 2;
    } else {
      body += ch === "\\" || ch === "]" || ch === "[" || ch === "^" ? `\\${ch}` : ch;
      i++;
    }
    first = false;
  }
  return undefined;
}

/** 与 `{` 配对的 `}` 下标；无则 -1。 */
function matchingBrace(p: string, start: number): number {
  let depth = 0;
  for (let i = start; i < p.length; i++) {
    const ch = p[i];
    if (ch === "\\") i++;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

export interface GlobBodyOptions {
  /** 是否识别 `{a,b}`（gitignore 不识别）。 */
  braces?: boolean;
}

/** 把 glob 翻译成不带锚点的正则源。 */
export function globBody(pattern: string, options: GlobBodyOptions = {}): string {
  const braces = options.braces ?? true;
  let out = "";
  const closers: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "\\" && i + 1 < pattern.length) {
      out += escapeChar(pattern[++i] as string);
    } else if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const atStart = i === 0 || pattern[i - 1] === "/";
        const next = pattern[i + 2];
        if (atStart && next === "/") {
          out += "(?:[^/]*/)*";
          i += 2;
        } else if (atStart && next === undefined) {
          out += ".*";
          i += 1;
        } else {
          out += "[^/]*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const cls = parseClass(pattern, i);
      if (cls) {
        out += cls[0];
        i = cls[1];
      } else out += "\\[";
    } else if (braces && ch === "{" && matchingBrace(pattern, i) > 0) {
      closers.push(matchingBrace(pattern, i));
      out += "(?:";
    } else if (braces && ch === "," && closers.length > 0) {
      out += "|";
    } else if (braces && ch === "}" && closers[closers.length - 1] === i) {
      closers.pop();
      out += ")";
    } else {
      out += escapeChar(ch);
    }
  }
  return out;
}

export interface GlobMatchOptions {
  nocase?: boolean;
}

export function globToRegExp(pattern: string, options: GlobMatchOptions = {}): RegExp {
  return new RegExp(`^${globBody(pattern)}$`, options.nocase ? "i" : "");
}

interface CompiledGlob {
  regex: RegExp;
  basename: boolean;
}

/** 多模式匹配器：正模式取并集，`!` 模式排除；只有排除模式时视为全集减排除。 */
export class GlobMatcher {
  private readonly include: CompiledGlob[] = [];
  private readonly exclude: CompiledGlob[] = [];

  constructor(patterns: string | readonly string[], options: GlobMatchOptions = {}) {
    const nocase = options.nocase ?? process.platform === "win32";
    for (const raw of typeof patterns === "string" ? [patterns] : patterns) {
      const negate = raw.startsWith("!");
      let p = negate ? raw.slice(1) : raw;
      if (p.startsWith("./")) p = p.slice(2);
      if (p === "") continue;
      const compiled = { regex: globToRegExp(p, { nocase }), basename: !p.includes("/") };
      (negate ? this.exclude : this.include).push(compiled);
    }
  }

  private static hit(g: CompiledGlob, rel: string): boolean {
    const target = g.basename ? (rel.split("/").pop() ?? rel) : rel;
    return g.regex.test(target);
  }

  /** `rel` 为相对搜索根的 `/` 分隔路径。 */
  matches(rel: string): boolean {
    const included = this.include.length === 0 || this.include.some((g) => GlobMatcher.hit(g, rel));
    return included && !this.exclude.some((g) => GlobMatcher.hit(g, rel));
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export interface GlobInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export const DEFAULT_GLOB_LIMIT = 1000;

export interface GlobMatchFile {
  abs: string;
  rel: string;
  mtimeMs: number;
}

/** 收集匹配文件并按 mtime 倒序（同 mtime 按路径）。 */
export async function globFiles(
  root: string,
  pattern: string | readonly string[],
  signal?: AbortSignal,
): Promise<GlobMatchFile[]> {
  const matcher = new GlobMatcher(pattern);
  const found: GlobMatchFile[] = [];
  for await (const entry of walk(root, signal ? { signal } : {})) {
    if (entry.isDir || !matcher.matches(entry.rel)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(entry.abs)).mtimeMs;
    } catch {
      continue;
    }
    found.push({ abs: entry.abs, rel: entry.rel, mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
  return found;
}

export async function executeGlob(input: GlobInput, ctx: ToolContext): Promise<ToolResult> {
  if (typeof input.pattern !== "string" || input.pattern === "") {
    return { content: "pattern must be a non-empty string", isError: true };
  }
  const limit = input.limit ?? DEFAULT_GLOB_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    return { content: "limit must be an integer ≥ 1", isError: true };
  }
  const root = resolvePath(input.path ?? ".", ctx.cwd);
  try {
    if (!(await stat(root)).isDirectory()) {
      return { content: `${displayPath(root, ctx.cwd)} is not a directory`, isError: true };
    }
  } catch {
    return { content: `Directory not found: ${displayPath(root, ctx.cwd)}`, isError: true };
  }
  const files = await globFiles(root, input.pattern, ctx.signal);
  if (files.length === 0) return { content: "No files found", details: { count: 0 } };
  const shown = files.slice(0, limit).map((f) => displayPath(f.abs, ctx.cwd));
  let content = shown.join("\n");
  if (files.length > limit) {
    content += `\n\n[${files.length} files matched; showing the ${limit} most recently modified. Narrow the pattern or raise limit.]`;
  }
  return { content, details: { count: files.length, truncated: files.length > limit } };
}

export function createGlobTool(): ToolDefinition<GlobInput> {
  return {
    name: "glob",
    label: "Glob",
    description:
      "Find files by glob (`**`, `*`, `?`, `[...]`, `{a,b}`, leading `!` excludes). " +
      "Patterns without `/` match names at any depth. Respects .gitignore/.ignore; newest first. " +
      "Use to discover files before read.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "e.g. **/*.ts" },
        path: { type: "string", description: "Directory (default: cwd)" },
        limit: { type: "integer", description: `Default ${DEFAULT_GLOB_LIMIT}` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    annotations: { readOnly: true },
    promptSnippet: "glob: find files by name pattern",
    execute: executeGlob,
  };
}
