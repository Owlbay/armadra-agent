/**
 * 外部 Agent 进程登记与孤儿清理（docs/wave5-plan.md §5.4 孤儿进程）。[W5-E]
 *
 * `<dataDir>/drivers/pids.json` 记 `{ pid, program, owner }`（owner = 起它的 ama 进程）。
 * 正常退出时 `process-tree.ts` 已同步杀掉仍存活的组；这里处理 ama 被 SIGKILL / 崩溃留下的孤儿：
 * 下次建外部 runner 时，owner 已不在的条目若进程组仍在、且（POSIX）`ps` 看到的命令行含登记的
 * 程序名，就杀进程树。对不上的（pid 被复用）只删登记不杀；Windows 不核对命令行，只删登记。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isGroupAlive, killProcessTree } from "../tools/process-tree.js";

export interface PidEntry {
  pid: number;
  program: string;
  owner: number;
  startedAt: number;
}

export function pidsFile(dataDir: string): string {
  return join(dataDir, "drivers", "pids.json");
}

function read(file: string): PidEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: PidEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function write(file: string, entries: readonly PidEntry[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // 登记失败不影响运行（退出时仍有 process-tree 的同步清理）
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ReapDeps {
  platform?: NodeJS.Platform;
  isOwnerAlive?(pid: number): boolean;
  isGroupAlive?(pid: number): boolean;
  /** POSIX：进程的命令行（`ps -o command= -p pid`）。 */
  commandOf?(pid: number): string | undefined;
  kill?(pid: number): Promise<unknown>;
}

function psCommand(pid: number): string | undefined {
  const out = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : undefined;
}

export class PidRegistry {
  constructor(private readonly file: string) {}

  add(pid: number, program: string): void {
    const entries = read(this.file).filter((e) => e.pid !== pid);
    entries.push({ pid, program, owner: process.pid, startedAt: Date.now() });
    write(this.file, entries);
  }

  remove(pid: number): void {
    const entries = read(this.file);
    const next = entries.filter((e) => e.pid !== pid);
    if (next.length !== entries.length) write(this.file, next);
  }

  entries(): PidEntry[] {
    return read(this.file);
  }

  /** 清理 owner 已不在的条目；返回被杀的 pid。 */
  async reapOrphans(deps: ReapDeps = {}): Promise<number[]> {
    const platform = deps.platform ?? process.platform;
    const ownerAlive = deps.isOwnerAlive ?? processAlive;
    const groupAlive = deps.isGroupAlive ?? ((pid: number) => isGroupAlive(pid));
    const commandOf = deps.commandOf ?? psCommand;
    const kill = deps.kill ?? ((pid: number) => killProcessTree(pid, { platform }));
    const keep: PidEntry[] = [];
    const killed: number[] = [];
    for (const entry of read(this.file)) {
      if (entry.owner === process.pid || ownerAlive(entry.owner)) {
        keep.push(entry);
        continue;
      }
      if (platform === "win32" || !groupAlive(entry.pid)) continue;
      const command = commandOf(entry.pid);
      if (command !== undefined && command.includes(basename(entry.program))) {
        await kill(entry.pid);
        killed.push(entry.pid);
      }
    }
    write(this.file, keep);
    return killed;
  }
}
