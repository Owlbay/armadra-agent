/**
 * 子 Agent 的 git worktree 隔离（docs/wave5-plan.md §7.4，D24）。[W5-G]
 *
 * - `git worktree add -b ama/task-<taskId> <repo>/.ama/worktrees/<taskId> HEAD`；子会话 cwd 指向
 *   worktree 里与父 cwd 对应的子目录；
 * - 结束时没有改动（工作区干净且 HEAD 未动）→ `git worktree remove --force` 并删分支；有改动则保留，
 *   结果里给分支名与 `git diff --stat`；
 * - 非 git 目录直接报错，不回落到共享目录；`.ama/worktrees/.gitignore` 写 `*`，父会话的 git 与
 *   grep / glob（读嵌套 .gitignore）都看不到这些目录；
 * - worktree 不保证可运行：依赖（node_modules 等）不共享。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface Worktree {
  /** worktree 根目录。 */
  path: string;
  /** 子会话 cwd（worktree 里与父 cwd 对应的目录）。 */
  cwd: string;
  branch: string;
  /** 创建时的提交（判断有无新提交）。 */
  base: string;
  repo: string;
}

export interface WorktreeOutcome {
  branch: string;
  changed: boolean;
  /** 有改动时：`git diff --stat <base>` 与未跟踪文件。 */
  diffStat?: string;
  /** 保留时的路径。 */
  path?: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

const TIMEOUT_MS = 30_000;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr).trim() || error.message));
        else resolve(String(stdout));
      },
    );
  });

/**
 * 两边都取系统的真实路径再比：git 给的是真实路径（macOS 的 /var → /private/var；Windows 是长文件名、
 * 正斜杠），而 cwd 可能是 8.3 短名（RUNNER~1）或符号链接。
 */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function worktreeBranch(taskId: string): string {
  return `ama/task-${taskId}`;
}

/** 在父 cwd 所在仓库里为任务建 worktree；非 git 目录抛错。 */
export async function createWorktree(
  cwd: string,
  taskId: string,
  git: GitRunner = runGit,
): Promise<Worktree> {
  let repo: string;
  try {
    repo = realPath((await git(["rev-parse", "--show-toplevel"], cwd)).trim());
  } catch {
    throw new Error(`isolation "worktree" needs a git repository; ${cwd} is not inside one`);
  }
  const base = (await git(["rev-parse", "HEAD"], repo)).trim();
  const root = join(repo, ".ama", "worktrees");
  mkdirSync(root, { recursive: true });
  const ignore = join(root, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const path = join(root, taskId);
  const branch = worktreeBranch(taskId);
  if (!existsSync(path)) await git(["worktree", "add", "-b", branch, path, base], repo);
  const sub = relative(repo, realPath(cwd));
  const childCwd = sub === "" || sub.startsWith("..") ? path : join(path, sub);
  mkdirSync(childCwd, { recursive: true });
  return { path, cwd: childCwd, branch, base, repo };
}

/** 运行结束：无改动删除 worktree 与分支；有改动保留并给 diff 摘要。 */
export async function finishWorktree(
  tree: Worktree,
  git: GitRunner = runGit,
): Promise<WorktreeOutcome> {
  const status = (await git(["status", "--porcelain"], tree.path)).trim();
  const head = (await git(["rev-parse", "HEAD"], tree.path)).trim();
  if (status === "" && head === tree.base) {
    await git(["worktree", "remove", "--force", tree.path], tree.repo);
    await git(["branch", "-D", tree.branch], tree.repo).catch(() => "");
    return { branch: tree.branch, changed: false };
  }
  const stat = (await git(["diff", "--stat", tree.base], tree.path).catch(() => "")).trim();
  const untracked = status
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3));
  const parts = [stat];
  if (untracked.length > 0) parts.push(`untracked: ${untracked.join(", ")}`);
  return {
    branch: tree.branch,
    changed: true,
    diffStat: parts.filter((part) => part !== "").join("\n"),
    path: tree.path,
  };
}
