/**
 * 作用域条目列表与 `MEMORY.md` 索引（docs/wave6-plan.md §3.2）。[W6-M]
 *
 * - 条目 = 作用域目录（含子目录）里的 `*.md`，跳过 `MEMORY.md`、隐藏文件 / 目录与符号链接；
 * - 排序：`updated` 降序，同日按文件路径；
 * - `MEMORY.md`：`- [name](file.md) — description` 一行一条，写操作后在作用域锁内重建（幂等，内容不变不写）。
 *   节渲染不读它，直接列条目（用户手改条目后 `/memory reload` 或下次会话即生效）。
 */

import { lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstLineOf, parseEntry } from "./frontmatter.js";
import { INDEX_FILE, type MemoryScope } from "./paths.js";

export interface MemoryEntry {
  scope: MemoryScope;
  /** 作用域内的相对路径（`/` 分隔），如 `prefers-pnpm.md`。 */
  file: string;
  name: string;
  description: string;
  type?: string;
  /** `YYYY-MM-DD`（缺 frontmatter 时取文件修改日期）。 */
  updated: string;
  bytes: number;
}

const MAX_DEPTH = 4;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function walk(dir: string, prefix: string, depth: number, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    let info;
    try {
      info = lstatSync(abs);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (info.isDirectory()) {
      if (depth < MAX_DEPTH) walk(abs, rel, depth + 1, out);
    } else if (info.isFile() && name.endsWith(".md") && !(prefix === "" && name === INDEX_FILE)) {
      out.push(rel);
    }
  }
}

/** 作用域里全部条目的相对路径（目录不存在 → 空）。`under` 限定子目录。 */
export function entryFiles(root: string, under = ""): string[] {
  const out: string[] = [];
  walk(under === "" ? root : join(root, ...under.split("/")), under, under.split("/").length, out);
  return out;
}

function stem(file: string): string {
  return (file.split("/").at(-1) ?? file).replace(/\.md$/, "");
}

export function readEntry(scope: MemoryScope, root: string, file: string): MemoryEntry | undefined {
  const abs = join(root, ...file.split("/"));
  let text: string;
  let mtime: number;
  try {
    text = readFileSync(abs, "utf8");
    mtime = lstatSync(abs).mtimeMs;
  } catch {
    return undefined;
  }
  const { meta, body } = parseEntry(text);
  const updated = /^\d{4}-\d{2}-\d{2}$/.test(meta["updated"] ?? "")
    ? (meta["updated"] as string)
    : isoDate(mtime);
  const entry: MemoryEntry = {
    scope,
    file,
    name: (meta["name"] ?? "").trim() || stem(file),
    description: (meta["description"] ?? "").trim() || firstLineOf(body),
    updated,
    bytes: Buffer.byteLength(text, "utf8"),
  };
  if (meta["type"] !== undefined && meta["type"] !== "") entry.type = meta["type"];
  return entry;
}

export function sortEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.sort((a, b) =>
    a.updated === b.updated ? a.file.localeCompare(b.file) : a.updated < b.updated ? 1 : -1,
  );
}

export function listEntries(scope: MemoryScope, root: string, under = ""): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const file of entryFiles(root, under)) {
    const entry = readEntry(scope, root, file);
    if (entry !== undefined) entries.push(entry);
  }
  return sortEntries(entries);
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
}

export function renderIndexFile(entries: readonly MemoryEntry[]): string {
  const lines = entries.map(
    (e) =>
      `- [${clean(e.name)}](${e.file})${e.description === "" ? "" : ` — ${clean(e.description)}`}`,
  );
  return [
    "# Memory index",
    "",
    "<!-- Maintained by ama after each memory write; edit the entries, not this file. -->",
    "",
    ...(lines.length === 0 ? ["(no entries)"] : lines),
    "",
  ].join("\n");
}

/** 重建 `MEMORY.md`（在作用域锁内调用；内容不变不写）。 */
export function rebuildIndex(scope: MemoryScope, root: string): void {
  const text = renderIndexFile(listEntries(scope, root));
  const path = join(root, INDEX_FILE);
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current === text) return;
  const tmp = join(root, `.${INDEX_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
