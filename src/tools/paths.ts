/**
 * 路径解析（设计 §5.2「通用安全」）。[B3]
 *
 * - 展开 `~` / `~/…`（`~user` 不展开）；相对路径按 cwd 解析；结果是规范化绝对路径。
 * - 含 NUL 的路径一律拒绝（AmaError invalid_arguments）。
 * - 符号链接策略：**跟随**，不做沙箱（信任边界是容器 / VM）。规则匹配用词法路径，
 *   `realPathOrSelf()` 给需要真实路径的调用方（如 ls 标注链接目标）。
 * - `toPosix()` 把路径统一成 `/` 分隔，供 glob / ignore / 权限规则匹配。
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AmaError } from "../errors.js";

export function assertNoNul(path: string): void {
  if (path.includes("\0")) {
    throw new AmaError("invalid_arguments", "Path must not contain NUL characters");
  }
}

/** 展开 `~` 与 `~/…`、`~\…`。 */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/** 解析为绝对路径；空串视为 cwd。 */
export function resolvePath(path: string, cwd: string, home?: string): string {
  assertNoNul(path);
  const trimmed = path.trim() === "" ? "." : path;
  const expanded = expandHome(trimmed, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function toPosix(path: string): string {
  return sep === "\\" ? path.replace(/\\/g, "/") : path;
}

/** cwd 内给相对路径，cwd 外给绝对路径；统一 `/`。 */
export function displayPath(absolutePath: string, cwd: string): string {
  const rel = relative(cwd, absolutePath);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return toPosix(absolutePath);
  return toPosix(rel);
}

/** 是否在 dir 之内（含 dir 本身）。 */
export function isWithin(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
