/**
 * 状态行的 git 信息（docs/wave5-plan.md §1.3）。[W5-A]
 *
 * - 分支与短提交零依赖读 `.git/HEAD`（`checkpoints/git-head.ts`，worktree / 子模块的 gitdir 文件、
 *   packed-refs 都认）；detached 时没有分支只显示短提交；还没有提交的分支只显示分支名。
 * - 工作区增删行：`git diff --numstat HEAD`（含暂存，不含未跟踪文件）后台子进程，环境加
 *   `GIT_OPTIONAL_LOCKS=0`；两次之间 ≥ `minIntervalMs`（缺省 10 s），超过 `timeoutMs`（缺省 2 s）或
 *   非零退出 / 起不来就省略增删项，并在本实例（本会话）停用 numstat，HEAD 仍照常显示。
 *   `AMA_STATUS_GIT=0` 直接关闭 numstat（排错用）。
 * - [W6] 领先 / 落后上游：当前分支在 git 配置里有 `branch.<名>.merge`（零依赖读 config，不起进程判断）时，
 *   numstat 之后同一节流周期再跑 `git rev-list --left-right --count @{upstream}...HEAD`（同样的超时与环境）；
 *   没有上游、detached、非零退出就省略；超时则本会话不再统计领先 / 落后。`AMA_STATUS_GIT=0` 同样关闭。
 * - 非 git 目录 `current()` 为 undefined（状态行整段省略）。
 * - `refresh()` 在回合边界调用（agent_settled、写类工具结束、回滚、/tree），只发起读取、不阻塞；
 *   结果有变化时通知 `onChange` 的监听者。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { findGitDir, readGitHead } from "../checkpoints/git-head.js";

export interface GitInfo {
  /** detached 时 undefined，显示短提交。 */
  branch?: string;
  /** 7 位；还没有提交时 undefined。 */
  shortHead?: string;
  /** 工作区（含暂存）相对 HEAD；拿不到为 undefined。 */
  insertions?: number;
  deletions?: number;
  /** [W6] 领先 / 落后上游的提交数；没有上游为 undefined。 */
  ahead?: number;
  behind?: number;
}

/** numstat 子进程的最小接口（测试注入）。 */
export interface NumstatProcess {
  stdout: NodeJS.ReadableStream | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type NumstatSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => NumstatProcess;

export interface GitInfoDeps {
  spawn?: NumstatSpawn;
  now?(): number;
  minIntervalMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export const GIT_NUMSTAT_INTERVAL_MS = 10_000;
export const GIT_NUMSTAT_TIMEOUT_MS = 2_000;

/** 解析 `git diff --numstat` 输出（二进制文件的 `-\t-` 跳过）。 */
export function parseNumstat(text: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    const match = /^(\d+)\t(\d+)\t/.exec(line);
    if (match === null) continue;
    insertions += Number(match[1]);
    deletions += Number(match[2]);
  }
  return { insertions, deletions };
}

/** `git rev-list --left-right --count @{upstream}...HEAD` 的输出：左（上游独有）= 落后，右 = 领先。 */
export function parseLeftRight(text: string): { ahead: number; behind: number } | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
  return match === null ? undefined : { behind: Number(match[1]), ahead: Number(match[2]) };
}

/** 分支在 git 配置里有没有上游（`[branch "<名>"]` 段里的 `merge`）；worktree 读主仓库的 config。 */
export async function hasUpstream(cwd: string, branch: string): Promise<boolean> {
  const gitDir = await findGitDir(cwd);
  if (gitDir === undefined) return false;
  const common = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => undefined))?.trim();
  const dir = common === undefined ? gitDir : isAbsolute(common) ? common : resolve(gitDir, common);
  const text = await readFile(join(dir, "config"), "utf8").catch(() => "");
  let inBranch = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const section = /^\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section !== null) {
      inBranch = section[1]?.toLowerCase() === "branch" && section[2] === branch;
      continue;
    }
    if (inBranch && /^merge\s*=\s*\S/i.test(line)) return true;
  }
  return false;
}

async function readHead(cwd: string): Promise<Pick<GitInfo, "branch" | "shortHead"> | undefined> {
  const head = await readGitHead(cwd);
  if (head !== undefined) {
    return {
      shortHead: head.head.slice(0, 7),
      ...(head.branch !== undefined ? { branch: head.branch } : {}),
    };
  }
  // 还没有提交（unborn 分支）：只有分支名
  const gitDir = await findGitDir(cwd);
  if (gitDir === undefined) return undefined;
  const text = await readFile(join(gitDir, "HEAD"), "utf8").catch(() => undefined);
  const match = /^ref:\s*refs\/heads\/(\S+)\s*$/.exec(text ?? "");
  return match?.[1] !== undefined ? { branch: match[1] } : undefined;
}

const sameInfo = (a: GitInfo | undefined, b: GitInfo | undefined): boolean =>
  a?.branch === b?.branch &&
  a?.shortHead === b?.shortHead &&
  a?.insertions === b?.insertions &&
  a?.deletions === b?.deletions &&
  a?.ahead === b?.ahead &&
  a?.behind === b?.behind &&
  (a === undefined) === (b === undefined);

export class GitInfoWatcher {
  private info: GitInfo | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly spawn: NumstatSpawn;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private numstatDisabled: boolean;
  private lastNumstatAt = Number.NEGATIVE_INFINITY;
  private numstatRunning = false;
  private headReading: Promise<void> | undefined;
  private headAgain = false;
  private disposed = false;
  private diff: { insertions: number; deletions: number } | undefined;
  private upstream: { ahead: number; behind: number } | undefined;
  private upstreamDisabled: boolean;

  constructor(
    private readonly cwd: string,
    deps: GitInfoDeps = {},
  ) {
    this.spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
    this.now = deps.now ?? Date.now;
    this.minIntervalMs = deps.minIntervalMs ?? GIT_NUMSTAT_INTERVAL_MS;
    this.timeoutMs = deps.timeoutMs ?? GIT_NUMSTAT_TIMEOUT_MS;
    this.env = deps.env ?? process.env;
    this.numstatDisabled = this.env["AMA_STATUS_GIT"] === "0";
    this.upstreamDisabled = this.numstatDisabled;
  }

  current(): GitInfo | undefined {
    return this.info;
  }

  /** numstat 已因超时 / 失败 / 环境变量停用。 */
  get numstatEnabled(): boolean {
    return !this.numstatDisabled;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** 回合边界调用：重读 HEAD；距上次 numstat ≥ minInterval 则后台起一次。返回本次读取完成的 Promise（测试用）。 */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.headReading !== undefined) {
      this.headAgain = true;
      return this.headReading;
    }
    const run = async (): Promise<void> => {
      do {
        this.headAgain = false;
        const head = await readHead(this.cwd).catch(() => undefined);
        this.update(head);
      } while (this.headAgain && !this.disposed);
      this.headReading = undefined;
      if (this.info !== undefined) await this.maybeNumstat();
    };
    this.headReading = run();
    return this.headReading;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private update(head: Pick<GitInfo, "branch" | "shortHead"> | undefined): void {
    const next: GitInfo | undefined =
      head === undefined
        ? undefined
        : {
            ...head,
            ...(this.diff !== undefined && head.shortHead !== undefined ? this.diff : {}),
            ...(this.upstream !== undefined && head.branch !== undefined ? this.upstream : {}),
          };
    if (sameInfo(this.info, next)) return;
    this.info = next;
    for (const listener of [...this.listeners]) listener();
  }

  private maybeNumstat(): Promise<void> {
    if (this.numstatDisabled || this.numstatRunning) return Promise.resolve();
    if (this.info?.shortHead === undefined) return Promise.resolve();
    const at = this.now();
    if (at - this.lastNumstatAt < this.minIntervalMs) return Promise.resolve();
    this.lastNumstatAt = at;
    this.numstatRunning = true;
    return this.numstat().then(async (diff) => {
      if (this.disposed) return;
      if (diff === undefined) {
        this.numstatDisabled = true;
        this.diff = undefined;
      } else this.diff = diff;
      await this.leftRight();
      this.numstatRunning = false;
      if (this.disposed) return;
      const info = this.info;
      if (info === undefined) return;
      const { insertions: _i, deletions: _d, ahead: _a, behind: _b, ...head } = info;
      this.update(head);
    });
  }

  /** 领先 / 落后上游：只在配置里有上游时起进程；超时本会话停用，非零退出只省略这一次。 */
  private async leftRight(): Promise<void> {
    const branch = this.info?.branch;
    if (this.upstreamDisabled || branch === undefined || !(await hasUpstream(this.cwd, branch))) {
      this.upstream = undefined;
      return;
    }
    const result = await this.run(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    if (result === "timeout") this.upstreamDisabled = true;
    this.upstream =
      typeof result === "object" && result.code === 0 ? parseLeftRight(result.out) : undefined;
  }

  private async numstat(): Promise<{ insertions: number; deletions: number } | undefined> {
    const result = await this.run(["diff", "--numstat", "HEAD"]);
    return typeof result === "object" && result.code === 0 ? parseNumstat(result.out) : undefined;
  }

  /** 后台起一次 git；起不来为 undefined，超时杀掉并返回 `"timeout"`。 */
  private run(
    args: readonly string[],
  ): Promise<{ code: number | null; out: string } | "timeout" | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      type Result = { code: number | null; out: string } | "timeout" | undefined;
      const done = (value: Result): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      let child: NumstatProcess;
      try {
        child = this.spawn("git", args, {
          cwd: this.cwd,
          env: { ...this.env, GIT_OPTIONAL_LOCKS: "0" },
        });
      } catch {
        resolve(undefined);
        return;
      }
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        done("timeout");
      }, this.timeoutMs);
      timer.unref?.();
      let out = "";
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk: string | Buffer) => {
        out += String(chunk);
      });
      child.on("error", () => done(undefined));
      child.on("close", (code) => done({ code, out }));
    });
  }
}
