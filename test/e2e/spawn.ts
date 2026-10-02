/**
 * 端到端冒烟的子进程辅助：跑 dist/bundle/ama.cjs（先 `pnpm build`），临时 HOME 隔离配置与会话。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TmpHome } from "../helpers/tmp-home.js";

export const BUNDLE = fileURLToPath(new URL("../../dist/bundle/ama.cjs", import.meta.url));
export const hasBundle = existsSync(BUNDLE);

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runAma(
  home: TmpHome,
  argv: string[],
  options: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...argv], {
      cwd: home.cwd,
      env: { ...home.env, AMA_NO_LOCAL_PROBE: "1", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ama 超时：${argv.join(" ")}\n${stderr}`));
    }, options.timeoutMs ?? 15_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

export type Line = Record<string, unknown>;

/** 解析 JSONL 输出（stream-json / rpc）。 */
export function jsonLines(stdout: string): Line[] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Line);
}

export interface RpcChild {
  lines: Line[];
  send(command: object): void;
  /** 等到出现满足条件的一行（从 `from` 下标起查找，缺省从头）。 */
  waitFor(pred: (line: Line) => boolean, from?: number, timeoutMs?: number): Promise<Line>;
  /** 关 stdin 并等待退出码。 */
  close(): Promise<number | null>;
  stderr(): string;
}

/** 起一个 `--mode rpc` 子进程，逐行收集输出。 */
export function spawnRpc(
  home: TmpHome,
  argv: string[],
  env: Record<string, string> = {},
): RpcChild {
  const child = spawn(process.execPath, [BUNDLE, "--mode", "rpc", ...argv], {
    cwd: home.cwd,
    env: { ...home.env, AMA_NO_LOCAL_PROBE: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Line[] = [];
  const waiters: (() => void)[] = [];
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      lines.push(JSON.parse(buffer.slice(0, at)) as Line);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
    for (const wake of waiters.splice(0)) wake();
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    lines,
    send: (command) => void child.stdin.write(`${JSON.stringify(command)}\n`),
    waitFor(pred, from = 0, timeoutMs = 15_000) {
      return new Promise<Line>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`rpc 等待超时\n${stderr}`)), timeoutMs);
        const check = (): void => {
          const hit = lines.slice(from).find(pred);
          if (hit !== undefined) {
            clearTimeout(timer);
            resolve(hit);
          } else waiters.push(check);
        };
        check();
      });
    },
    close() {
      child.stdin.end();
      return exited;
    },
    stderr: () => stderr,
  };
}
