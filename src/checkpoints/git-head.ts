/**
 * 读 git HEAD（docs/history/rewind-plan.md §1.2、D6）。[RW-A]
 *
 * 不起 git 进程：从 cwd 向上找 `.git`（目录，或 worktree / 子模块的 `gitdir: <路径>` 文件），读 `HEAD`；
 * 符号引用先查 gitdir 再查 `commondir`（worktree 的分支引用在主仓库），最后查 `packed-refs`。
 * 读不到（不在仓库、未提交过的分支、格式不认识）返回 undefined。
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface GitHead {
  head: string;
  branch?: string;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 找到 cwd 所在仓库的 gitdir；不在仓库返回 undefined。 */
export async function findGitDir(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".git");
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
      if (info.isFile()) {
        const text = (await readText(candidate)) ?? "";
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
        if (match?.[1] !== undefined) {
          return isAbsolute(match[1]) ? match[1] : resolve(dir, match[1]);
        }
      }
    } catch {
      // 没有 .git：继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function resolveRef(gitDir: string, ref: string): Promise<string | undefined> {
  const commonText = await readText(join(gitDir, "commondir"));
  const commonDir =
    commonText === undefined
      ? gitDir
      : isAbsolute(commonText.trim())
        ? commonText.trim()
        : resolve(gitDir, commonText.trim());
  const dirs = commonDir === gitDir ? [gitDir] : [gitDir, commonDir];
  for (const dir of dirs) {
    const text = (await readText(join(dir, ...ref.split("/"))))?.trim();
    if (text !== undefined && SHA.test(text)) return text;
  }
  for (const dir of dirs) {
    const packed = await readText(join(dir, "packed-refs"));
    if (packed === undefined) continue;
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha !== undefined && SHA.test(sha)) return sha;
    }
  }
  return undefined;
}

/** cwd 所在仓库的 HEAD 提交与分支；detached 时没有 branch。 */
export async function readGitHead(cwd: string): Promise<GitHead | undefined> {
  const gitDir = await findGitDir(cwd);
  if (gitDir === undefined) return undefined;
  const head = (await readText(join(gitDir, "HEAD")))?.trim();
  if (head === undefined) return undefined;
  if (SHA.test(head)) return { head };
  const match = /^ref:\s*(\S+)$/.exec(head);
  if (match?.[1] === undefined) return undefined;
  const ref = match[1];
  const sha = await resolveRef(gitDir, ref);
  if (sha === undefined) return undefined;
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
  return { head: sha, ...(branch !== undefined ? { branch } : {}) };
}
