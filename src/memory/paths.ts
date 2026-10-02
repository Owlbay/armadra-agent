/**
 * 记忆的目录与逻辑路径（docs/wave6-plan.md §3.2、D9、D11）。[W6-M]
 *
 * - 独立终端：`<dataDir>/memory/user/` 与 `<dataDir>/memory/projects/<slug>-<sha8>/`；sha8 = 项目根真实路径的
 *   sha256 前 8 位。项目根：git 顶层（worktree 取主仓库，经 `commondir`）；子模块取子模块自己的检出；
 *   不在 git 里取 cwd。不起 git 进程。
 * - 嵌入宿主：只有 `workspace` 一个作用域，映射到 profile / SDK 给的 `dir`。
 * - 模型看到的是逻辑路径 `/memories/<scope>/<file>.md`。解析时拒绝 `..`、`.`、隐藏段、反斜杠、控制字符、
 *   百分号编码（`%2e%2e%2f` 之类）、非 `.md` 文件；映射后的绝对路径必须仍在作用域根内；根以下任何一段是
 *   符号链接都拒绝（`assertNoSymlink`，访问磁盘前调用）。
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type MemoryScope = "user" | "project" | "workspace";
/** 作用域的固定顺序（节、列表、CLI 输出都按它排）。 */
export const MEMORY_SCOPE_ORDER: readonly MemoryScope[] = ["user", "project", "workspace"];

export const MEMORY_ROOT = "/memories";
/** 每个作用域自动重建的索引文件。 */
export const INDEX_FILE = "MEMORY.md";
/** 项目作用域目录里记下项目根（`{ root, createdAt }`）。 */
export const META_FILE = "meta.json";

const MAX_PATH = 512;
const MAX_SEGMENT = 128;

/** 作用域 → 绝对目录（只列启用的作用域）。 */
export type ScopeRoots = Partial<Record<MemoryScope, string>>;

/** 路径不合法（给模型的英文说明）。 */
export class MemoryPathError extends Error {
  readonly code = "invalid_path";
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** 记忆按哪个目录分桶：git 顶层（worktree → 主仓库）；不在 git 里取 cwd。 */
export function projectRootOf(cwd: string): string {
  const start = real(cwd);
  let dir = start;
  for (;;) {
    const dotGit = join(dir, ".git");
    let kind: "dir" | "file" | undefined;
    try {
      const info = statSync(dotGit);
      kind = info.isDirectory() ? "dir" : info.isFile() ? "file" : undefined;
    } catch {
      kind = undefined;
    }
    if (kind === "dir") return dir;
    if (kind === "file") {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit));
      const target = match?.[1];
      if (target !== undefined) {
        const gitDir = isAbsolute(target) ? target : resolve(dir, target);
        const common = readText(join(gitDir, "commondir")).trim();
        if (common !== "") {
          const commonDir = real(isAbsolute(common) ? common : resolve(gitDir, common));
          return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
        }
      }
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** `<slug>-<sha8>`：slug 取目录名（只留 `[A-Za-z0-9._-]`，至多 40 个字符）。 */
export function projectBucket(root: string): string {
  const slug =
    basename(root)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+/, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "root";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export function memoryBaseDir(dataDir: string): string {
  return join(dataDir, "memory");
}

/** 独立终端的作用域目录（不创建；首次写入时才建）。 */
export function standaloneRoots(input: {
  dataDir: string;
  /** 项目根（`projectRootOf(cwd)`）；undefined = 不启用项目作用域。 */
  projectRoot?: string | undefined;
  user: boolean;
}): ScopeRoots {
  const base = memoryBaseDir(input.dataDir);
  const roots: ScopeRoots = {};
  if (input.user) roots.user = join(base, "user");
  if (input.projectRoot !== undefined)
    roots.project = join(base, "projects", projectBucket(input.projectRoot));
  return roots;
}

export function logicalPath(scope: MemoryScope, file?: string): string {
  return file === undefined || file === ""
    ? `${MEMORY_ROOT}/${scope}`
    : `${MEMORY_ROOT}/${scope}/${file}`;
}

export type MemoryTarget =
  | { kind: "root" }
  | { kind: "dir"; scope: MemoryScope; root: string; file: string; abs: string }
  | { kind: "file"; scope: MemoryScope; root: string; file: string; abs: string };

function scopesText(roots: ScopeRoots): string {
  const names = MEMORY_SCOPE_ORDER.filter((s) => roots[s] !== undefined);
  return names.length === 0 ? "(none)" : names.map((s) => logicalPath(s)).join(", ");
}

/** 逻辑路径 → 目标；不合法抛 MemoryPathError。 */
export function parseMemoryPath(path: unknown, roots: ScopeRoots): MemoryTarget {
  if (typeof path !== "string" || path === "")
    throw new MemoryPathError("path must be a non-empty string such as /memories/user/note.md");
  if (path.length > MAX_PATH) throw new MemoryPathError("path is too long");
  if (path.includes("\\")) throw new MemoryPathError("path must use forward slashes");
  if (/[\u0000-\u001f\u007f]/.test(path))
    throw new MemoryPathError("path contains control characters");
  if (/%[0-9a-fA-F]{2}/.test(path)) throw new MemoryPathError("path must not be URL-encoded");
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === MEMORY_ROOT) return { kind: "root" };
  if (!trimmed.startsWith(`${MEMORY_ROOT}/`))
    throw new MemoryPathError(
      `path must start with ${MEMORY_ROOT}/ (scopes: ${scopesText(roots)})`,
    );
  const segments = trimmed.slice(MEMORY_ROOT.length + 1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      throw new MemoryPathError("path must not contain empty, '.' or '..' segments");
    if (segment.startsWith(".")) throw new MemoryPathError("hidden files are not allowed");
    if (segment.length > MAX_SEGMENT) throw new MemoryPathError("path segment is too long");
  }
  const scope = segments[0] as MemoryScope;
  const root = MEMORY_SCOPE_ORDER.includes(scope) ? roots[scope] : undefined;
  if (root === undefined)
    throw new MemoryPathError(`unknown memory scope "${segments[0]}"; use ${scopesText(roots)}`);
  const rest = segments.slice(1);
  const abs = rest.length === 0 ? root : join(root, ...rest);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new MemoryPathError("path escapes memory");
  const file = rest.join("/");
  const last = rest.at(-1);
  if (last !== undefined && last.toLowerCase().endsWith(".md")) {
    if (!last.endsWith(".md")) throw new MemoryPathError("memory files must end with .md");
    return { kind: "file", scope, root, file, abs };
  }
  if (last !== undefined && /\.[A-Za-z0-9]+$/.test(last))
    throw new MemoryPathError("memory files must be Markdown (.md)");
  return { kind: "dir", scope, root, file, abs };
}

/** 作用域根以下（不含根）的每一段若已存在且是符号链接，拒绝。 */
export function assertNoSymlink(root: string, abs: string): void {
  const rel = relative(root, abs);
  if (rel === "") return;
  let current = root;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return;
    }
    if (isLink) throw new MemoryPathError("symbolic links are not allowed in memory");
  }
}
