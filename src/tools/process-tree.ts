/**
 * 进程组与杀树（设计 §5.2 bash、§4.2）。[B3]
 *
 * - POSIX：bash 以 `detached: true` 启动，自成进程组（pgid = pid）；杀树 = 对 `-pid` 发 SIGTERM，
 *   每 50 ms 探测组是否还在，宽限 2 s 后 SIGKILL。
 * - Windows：`taskkill /PID <pid> /T /F`（没有优雅阶段）。
 * - 信号退出的退出码按 shell 惯例 `128 + signo`。
 * - 启动过的进程组登记在案；本进程 `exit` 时同步 SIGKILL 仍存活的组（Windows 同步 taskkill）。
 */

import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";

export const KILL_GRACE_MS = 2000;
const POLL_MS = 50;

export interface ProcessDeps {
  platform?: NodeJS.Platform;
  /** 缺省 process.kill。 */
  kill?(pid: number, signal: NodeJS.Signals | 0): void;
  /** Windows taskkill 的执行器；缺省 spawn。 */
  runTaskkill?(args: readonly string[]): Promise<void>;
  graceMs?: number;
}

/** 信号名 → `128 + signo`；未知信号按 SIGTERM 处理。 */
export function signalExitCode(signal: NodeJS.Signals | string): number {
  const signo = (constants.signals as Record<string, number | undefined>)[signal];
  return 128 + (signo ?? constants.signals.SIGTERM);
}

/** 子进程结束时的退出码：正常退出取 code，信号退出取 128+signo。 */
export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return signalExitCode(signal);
  return 1;
}

export function taskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

function defaultTaskkill(args: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn("taskkill", [...args], { stdio: "ignore", windowsHide: true });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    } catch {
      resolve();
    }
  });
}

/** 进程组（POSIX）是否还有成员。 */
export function isGroupAlive(pid: number, deps: ProcessDeps = {}): boolean {
  const kill = deps.kill ?? ((p: number, s: NodeJS.Signals | 0) => process.kill(p, s));
  try {
    kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sendGroup(pid: number, signal: NodeJS.Signals, deps: ProcessDeps): void {
  const kill = deps.kill ?? ((p: number, s: NodeJS.Signals | 0) => process.kill(p, s));
  try {
    kill(-pid, signal);
  } catch {
    try {
      kill(pid, signal);
    } catch {
      // 已退出
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 杀整棵进程树。POSIX：SIGTERM → 宽限（缺省 2 s，组提前消失则提前返回）→ SIGKILL。
 * 返回实际是否升级到了 SIGKILL（Windows 恒为 false）。
 */
export async function killProcessTree(pid: number, deps: ProcessDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    await (deps.runTaskkill ?? defaultTaskkill)(taskkillArgs(pid));
    return false;
  }
  sendGroup(pid, "SIGTERM", deps);
  const deadline = Date.now() + (deps.graceMs ?? KILL_GRACE_MS);
  while (Date.now() < deadline) {
    if (!isGroupAlive(pid, deps)) return false;
    await sleep(POLL_MS);
  }
  if (!isGroupAlive(pid, deps)) return false;
  sendGroup(pid, "SIGKILL", deps);
  return true;
}

// ---------------------------------------------------------------------------
// 登记与退出清理
// ---------------------------------------------------------------------------

const tracked = new Set<number>();
let exitHookInstalled = false;

export function trackProcessGroup(pid: number): void {
  tracked.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => killTrackedSync());
  }
}

export function untrackProcessGroup(pid: number): void {
  tracked.delete(pid);
}

export function trackedProcessGroups(): readonly number[] {
  return [...tracked];
}

/** 同步清理（只能在 `exit` 里用同步 API）。 */
export function killTrackedSync(deps: ProcessDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  for (const pid of tracked) {
    if (platform === "win32") {
      try {
        spawnSync("taskkill", taskkillArgs(pid), { stdio: "ignore", windowsHide: true });
      } catch {
        // 忽略
      }
    } else if (isGroupAlive(pid, deps)) {
      sendGroup(pid, "SIGKILL", deps);
    }
  }
  tracked.clear();
}
