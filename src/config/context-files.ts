/**
 * 项目上下文文件（AGENTS.md）向上查找（设计 §1.2、§10.1、§11.1 第 10 步）。[B5]
 *
 * - 每个目录取第一个存在的：`AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD`。
 * - 顺序：用户级 `<configDir>/AGENTS.md`（全局约定）在最前，其后祖先由外向内，cwd 最后。
 * - 去重：同一真实路径只取一次（符号链接）；内容与已收集文件完全相同的跳过——
 *   git worktree 放在主仓库目录内（如 `.worktrees/x`）时，向上会再碰到主仓库的同一份
 *   AGENTS.md，它不带来新信息。
 * - 不需要信任（§7.3）。读错记 warning 继续。
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { ancestorsOf } from "./trust.js";

export const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"] as const;

export interface ContextFile {
  path: string;
  content: string;
  scope: "user" | "project";
}

export interface FindContextFilesInput {
  cwd: string;
  /** 用户级配置目录；undefined 则不读全局 AGENTS.md。 */
  configDir?: string | undefined;
  /** 单文件上限（字节），超出截断并 warning；缺省 256 KiB。 */
  maxBytes?: number;
}

export interface FindContextFilesResult {
  files: ContextFile[];
  warnings: string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 目录里按优先级取第一个存在的上下文文件。 */
export function pickContextFile(dir: string): string | undefined {
  for (const name of CONTEXT_FILE_NAMES) {
    const candidate = join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

export function findContextFiles(input: FindContextFilesInput): FindContextFilesResult {
  const maxBytes = input.maxBytes ?? 256 * 1024;
  const files: ContextFile[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  const seenContent = new Set<string>();

  const add = (path: string, scope: ContextFile["scope"]): void => {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      real = path;
    }
    if (seenPaths.has(real)) return;
    seenPaths.add(real);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      warnings.push(`${path}: 读取失败（${(error as Error).message}）`);
      return;
    }
    if (Buffer.byteLength(content) > maxBytes) {
      content = Buffer.from(content).subarray(0, maxBytes).toString("utf8");
      warnings.push(`${path}: 超过 ${maxBytes} 字节，已截断`);
    }
    if (seenContent.has(content)) return;
    seenContent.add(content);
    files.push({ path, content, scope });
  };

  if (input.configDir !== undefined) {
    const global = pickContextFile(input.configDir);
    if (global !== undefined) add(global, "user");
  }
  for (const dir of ancestorsOf(input.cwd).reverse()) {
    const found = pickContextFile(dir);
    if (found !== undefined) add(found, "project");
  }
  return { files, warnings };
}
