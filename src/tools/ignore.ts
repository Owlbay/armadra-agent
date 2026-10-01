/**
 * `.gitignore` / `.ignore` 解析与匹配，以及尊重它们的目录遍历（设计 §5.2 grep / glob）。[B3]
 *
 * 规则语义（gitignore 子集）：空行与 `#` 注释；`\#`、`\!`、`\ ` 转义；`!` 取反；末尾 `/` 只匹配目录；
 * 中间或开头含 `/` 的模式锚定在 ignore 文件所在目录，否则匹配任意深度的名字；`**` 的三种位置；
 * 同一路径**最后**命中的规则生效；被忽略的目录不再下钻（其下的取反规则无效，与 git 一致）。
 * 嵌套：每个目录的 `.gitignore` 先、`.ignore` 后（后者优先）；从搜索根向上到仓库根（含 `.git` 的
 * 目录）的祖先 ignore 文件也生效。`.git` 目录永远跳过；目录符号链接不跟随。
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { toPosix } from "./paths.js";
import { globBody } from "./glob.js";

export interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
  /** ignore 文件所在目录（绝对路径，`/` 分隔，无尾斜杠）。 */
  base: string;
  source: string;
}

export const IGNORE_FILES = [".gitignore", ".ignore"] as const;

function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " " && line[end - 2] !== "\\") end--;
  return line.slice(0, end);
}

/** 解析一行；空 / 注释返回 undefined。 */
export function parseIgnoreLine(
  rawLine: string,
  base: string,
  nocase = false,
): IgnoreRule | undefined {
  let line = trimTrailingSpaces(rawLine.replace(/\r$/, ""));
  if (line === "" || line.startsWith("#")) return undefined;
  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith("/") && !line.endsWith("\\/")) {
    dirOnly = true;
    line = line.replace(/\/+$/, "");
  }
  if (line === "") return undefined;
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  const body = globBody(line, { braces: false });
  const prefix = anchored || line.startsWith("**/") ? "" : "(?:[^/]*/)*";
  return {
    negate,
    dirOnly,
    regex: new RegExp(`^${prefix}${body}$`, nocase ? "i" : ""),
    base: base.replace(/\/+$/, ""),
    source: rawLine,
  };
}

export function parseIgnoreFile(content: string, base: string, nocase = false): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of content.split("\n")) {
    const rule = parseIgnoreLine(line, base, nocase);
    if (rule) rules.push(rule);
  }
  return rules;
}

/** `absPosix` 相对 `base` 的路径；不在其下返回 undefined。 */
function relativeTo(base: string, absPosix: string): string | undefined {
  if (base === "") return absPosix.replace(/^\/+/, "");
  if (absPosix === base) return "";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return absPosix.startsWith(prefix) ? absPosix.slice(prefix.length) : undefined;
}

/** 按规则顺序求值，最后命中者生效。 */
export function isIgnoredBy(
  rules: readonly IgnoreRule[],
  absPath: string,
  isDir: boolean,
): boolean {
  const absPosix = toPosix(absPath);
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const rel = relativeTo(rule.base, absPosix);
    if (rel === undefined || rel === "") continue;
    if (rule.regex.test(rel)) ignored = !rule.negate;
  }
  return ignored;
}

async function readRules(dir: string, nocase: boolean): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const name of IGNORE_FILES) {
    try {
      const text = await readFile(join(dir, name), "utf8");
      rules.push(...parseIgnoreFile(text, toPosix(dir), nocase));
    } catch {
      // 不存在
    }
  }
  return rules;
}

/** 搜索根之上、直到仓库根（含 `.git` 的目录）的祖先 ignore 规则，外层在前。 */
export async function ancestorRules(root: string, nocase = false): Promise<IgnoreRule[]> {
  const chain: string[] = [];
  let dir = root;
  let foundRepo = await exists(join(root, ".git"));
  while (!foundRepo) {
    const parent = dirname(dir);
    if (parent === dir) return [];
    dir = parent;
    chain.unshift(dir);
    foundRepo = await exists(join(dir, ".git"));
  }
  const rules: IgnoreRule[] = [];
  for (const d of chain) rules.push(...(await readRules(d, nocase)));
  return rules;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface WalkEntry {
  abs: string;
  /** 相对遍历根，`/` 分隔。 */
  rel: string;
  isDir: boolean;
}

export interface WalkOptions {
  /** 缺省 true。 */
  respectIgnore?: boolean;
  signal?: AbortSignal;
  /** 只在 Windows 上缺省大小写不敏感。 */
  nocase?: boolean;
}

/** 深度优先、目录内按名字排序的遍历；产出文件与目录（目录先于其内容）。 */
export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const respect = options.respectIgnore ?? true;
  const nocase = options.nocase ?? process.platform === "win32";
  const base = respect ? await ancestorRules(root, nocase) : [];
  yield* walkDir(root, "", base, respect, nocase, options.signal);
}

async function* walkDir(
  dir: string,
  rel: string,
  inherited: IgnoreRule[],
  respect: boolean,
  nocase: boolean,
  signal: AbortSignal | undefined,
): AsyncGenerator<WalkEntry> {
  if (signal?.aborted) return;
  const rules = respect ? [...inherited, ...(await readRules(dir, nocase))] : inherited;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (signal?.aborted) return;
    if (entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      // 链接到文件的照常产出；链接到目录的不跟随（避免环），作为普通条目跳过。
      try {
        if ((await stat(abs)).isDirectory()) continue;
      } catch {
        continue;
      }
      isDir = false;
    } else if (!isDir && !entry.isFile()) {
      continue;
    }
    if (respect && isIgnoredBy(rules, abs, isDir)) continue;
    yield { abs, rel: childRel, isDir };
    if (isDir) yield* walkDir(abs, childRel, rules, respect, nocase, signal);
  }
}
