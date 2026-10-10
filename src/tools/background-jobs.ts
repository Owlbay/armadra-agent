/**
 * 后台命令（docs/history/wave5-plan.md §8.3 H6，D29：不加新工具，`bash{background}` + `bash{job, action}`）。[W5-H2]
 *
 * - `start`：调用方（bash.ts）给出 `spawn(stdout)`——**进程只在 bash.ts 的 `spawnShell` 里创建**，
 *   这里只拿到 ChildProcess；stdout / stderr 直接写进 `outputPath`（文件描述符交给子进程，ama 退出也不
 *   会因管道断开而 SIGPIPE）。POSIX 自成进程组并登记（进程退出时同步 SIGKILL 残留组）。
 * - `wait(id, timeoutMs)`：等到退出或超时；`stop(id)`：杀整棵树（SIGTERM → 宽限 → SIGKILL）；
 *   `output(id, options?)`：读输出文件尾部（缺省 2000 行 / 50 KB，调用方可传字节上限）。
 * - 生命周期事件经 `onChange` 发出（started / exited / stopped）；`takeExited()` 取走尚未通知的已退出
 *   任务（提醒通道 reminders.ts 据此告诉模型「后台命令 jobId 已退出（码 N）」）。
 * - 按会话 id 登记（`jobsForSession`）；`disposeSessionJobs` 在会话 dispose 时回收进程树。
 */

import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  exitCodeOf,
  isGroupAlive,
  killProcessTree,
  trackProcessGroup,
  untrackProcessGroup,
  type ProcessDeps,
} from "./process-tree.js";
import { truncateTail, type TruncateOptions, type TruncateResult } from "./truncate.js";

export type JobStatus = "running" | "exited" | "stopped";

export interface Job {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  outputPath: string;
  startedAt: number;
  status: JobStatus;
  /** 退出码（信号退出为 128 + signo）；运行中 undefined。 */
  exitCode?: number;
  endedAt?: number;
}

export interface JobStartOptions {
  cwd: string;
  outputPath: string;
  /** 用给定的输出文件描述符启动进程（bash.ts 的 spawnShell）。 */
  spawn(outputFd: number): ChildProcess;
  processDeps?: ProcessDeps;
}

export type JobChange = { phase: "started" | "exited" | "stopped"; job: Job };

/** 后台 bash 的查询形状：`{ job, action: wait | stop | output }`，不带 command。 */
export function isBackgroundJobQuery(toolName: string, input: unknown): boolean {
  if (toolName !== "bash" || typeof input !== "object" || input === null) return false;
  const record = input as { command?: unknown; job?: unknown };
  return typeof record.job === "string" && record.command === undefined;
}

interface Entry {
  job: Job;
  done: Promise<void>;
  notified: boolean;
  stopping: boolean;
  processDeps: ProcessDeps | undefined;
}

export class BackgroundJobs {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(change: JobChange) => void>();
  private seq = 0;

  start(command: string, options: JobStartOptions): Job {
    mkdirSync(dirname(options.outputPath), { recursive: true });
    const fd = openSync(options.outputPath, "a");
    let child: ChildProcess;
    try {
      child = options.spawn(fd);
    } finally {
      closeSync(fd);
    }
    const id = `bg${++this.seq}`;
    const job: Job = {
      id,
      command,
      cwd: options.cwd,
      outputPath: options.outputPath,
      startedAt: Date.now(),
      status: "running",
    };
    if (child.pid !== undefined) job.pid = child.pid;
    const isWindows = (options.processDeps?.platform ?? process.platform) === "win32";
    if (job.pid !== undefined && !isWindows) trackProcessGroup(job.pid);
    const entry: Entry = {
      job,
      notified: false,
      stopping: false,
      processDeps: options.processDeps,
      done: new Promise<void>((resolve) => {
        const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (job.status !== "running") return resolve();
          job.exitCode = exitCodeOf(code, signal);
          job.endedAt = Date.now();
          job.status = entry.stopping ? "stopped" : "exited";
          const pid = job.pid;
          if (pid !== undefined && !isWindows && !isGroupAlive(pid, options.processDeps ?? {}))
            untrackProcessGroup(pid);
          this.notify({ phase: job.status === "stopped" ? "stopped" : "exited", job });
          resolve();
        };
        child.once("exit", finish);
        child.once("error", () => finish(127, null));
      }),
    };
    child.unref();
    this.entries.set(id, entry);
    this.notify({ phase: "started", job });
    return job;
  }

  get(id: string): Job | undefined {
    return this.entries.get(id)?.job;
  }

  list(): Job[] {
    return [...this.entries.values()].map((entry) => entry.job);
  }

  /** 等到退出或超时（`signal` 可提前结束等待，不杀进程）。 */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Job | undefined> {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.job.status !== "running") return entry.job;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      entry.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        onAbort = () => resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    return entry.job;
  }

  async stop(id: string): Promise<Job | undefined> {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.job.status !== "running") return entry.job;
    entry.stopping = true;
    // 已经由调用方知道结果：停止的任务不再经提醒通道通知
    entry.notified = true;
    if (entry.job.pid !== undefined) await killProcessTree(entry.job.pid, entry.processDeps);
    await entry.done;
    return entry.job;
  }

  /** 输出文件尾部（缺省 2000 行 / 50 KB；调用方可传字节上限，#155）。 */
  output(id: string, options: TruncateOptions = {}): (TruncateResult & { job: Job }) | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    let text = "";
    try {
      if (statSync(entry.job.outputPath).size > 0)
        text = readFileSync(entry.job.outputPath, "utf8");
    } catch {
      // 输出文件被删：按空输出
    }
    return { ...truncateTail(text, options), job: entry.job };
  }

  /** 取走已退出、尚未通知的任务（提醒通道用；wait 已看到退出的也算已知）。 */
  takeExited(): Job[] {
    const out: Job[] = [];
    for (const entry of this.entries.values()) {
      if (entry.job.status === "running" || entry.notified) continue;
      entry.notified = true;
      out.push(entry.job);
    }
    return out;
  }

  /** 标记为已知（模型已经通过 wait / output 看到了退出）。 */
  markSeen(id: string): void {
    const entry = this.entries.get(id);
    if (entry !== undefined && entry.job.status !== "running") entry.notified = true;
  }

  onChange(listener: (change: JobChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get running(): number {
    return this.list().filter((job) => job.status === "running").length;
  }

  /** 杀掉全部仍在运行的任务（会话 dispose）。 */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id).catch(() => undefined)));
    this.listeners.clear();
  }

  private notify(change: JobChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // 监听器异常不影响任务
      }
    }
  }
}

const registry = new Map<string, BackgroundJobs>();

/** 会话的后台任务表（按会话 id，首次使用时建）。 */
export function jobsForSession(sessionId: string): BackgroundJobs {
  let jobs = registry.get(sessionId);
  if (jobs === undefined) {
    jobs = new BackgroundJobs();
    registry.set(sessionId, jobs);
  }
  return jobs;
}

/** 已有的任务表（不新建）。 */
export function existingJobs(sessionId: string): BackgroundJobs | undefined {
  return registry.get(sessionId);
}

/** 会话 dispose：杀掉该会话仍在运行的后台任务并注销。 */
export async function disposeSessionJobs(sessionId: string): Promise<void> {
  const jobs = registry.get(sessionId);
  if (jobs === undefined) return;
  registry.delete(sessionId);
  await jobs.disposeAll();
}
