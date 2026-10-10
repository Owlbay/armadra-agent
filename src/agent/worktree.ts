/**
 * 子 Agent 的 git worktree 隔离（docs/history/wave5-plan.md §7.4，D24）。[W5-G]
 *
 * - `git worktree add -b ama/task-<taskId> <repo>/.ama/worktrees/<taskId> HEAD`；子会话 cwd 指向
 *   worktree 里与父 cwd 对应的子目录；
 * - 结束时没有改动（工作区干净且 HEAD 未动）→ `git worktree remove --force` 并删分支；有改动则保留，
 *   结果里给分支名与 `git diff --stat`；
 * - 非 git 目录直接报错，不回落到共享目录；`.ama/worktrees/.gitignore` 写 `*`，父会话的 git 与
 *   grep / glob（读嵌套 .gitignore）都看不到这些目录；
 * - worktree 不保证可运行：依赖（node_modules 等）不共享。
 * - 并发：同一仓库的 `worktree add / remove` 与删分支会扫描、改写 `.git/worktrees/*`，并行的两个隔离
 *   任务曾互相读到对方建了一半的管理目录（`无法读取 .git/worktrees/<id>/commondir`）。同进程内按仓库的
 *   公共 git 目录串行；跨进程（两个 ama 同时开隔离任务）的同类瞬时错误短暂重试。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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

/** 每个仓库（按公共 git 目录）一条队列：worktree 的增删与删分支串行执行。 */
const queues = new Map<string, Promise<unknown>>();

export function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return current;
}

/** 另一个进程正在增删 worktree 时 git 报的瞬时错误（读到半建的管理目录、锁文件已存在）。 */
const TRANSIENT =
  /commondir|gitdir|could not read|unable to read|无法读取|\.lock'?: File exists|Unable to create '.*\.lock'|无法创建 '.*\.lock'/i;

export async function retryTransient<T>(
  run: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 50;
  for (let n = 1; ; n++) {
    try {
      return await run();
    } catch (error) {
      if (n >= attempts || !TRANSIENT.test(error instanceof Error ? error.message : String(error)))
        throw error;
      await new Promise((r) => setTimeout(r, delayMs * n));
    }
  }
}

/** 仓库的公共 git 目录（所有 worktree 共享），作为串行队列的键。 */
async function commonDir(repo: string, git: GitRunner): Promise<string> {
  try {
    return realPath(resolve(repo, (await git(["rev-parse", "--git-common-dir"], repo)).trim()));
  } catch {
    return repo;
  }
}

/** 串行 + 瞬时错误重试地跑一条会改动 `.git/worktrees` 的 git 命令。 */
function mutate(key: string, git: GitRunner, args: readonly string[], cwd: string) {
  return serialized(key, () => retryTransient(() => git(args, cwd)));
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
  const key = await commonDir(repo, git);
  if (!existsSync(path))
    await mutate(key, git, ["worktree", "add", "-b", branch, path, base], repo);
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
    const key = await commonDir(tree.repo, git);
    await mutate(key, git, ["worktree", "remove", "--force", tree.path], tree.repo);
    await mutate(key, git, ["branch", "-D", tree.branch], tree.repo).catch(() => "");
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
