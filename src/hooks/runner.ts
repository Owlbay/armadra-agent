/**
 * Hook 子进程执行（设计 §6.1「退出码语义」「并行与顺序」）。[B5]
 *
 * - POSIX：`sh -c <command>`，独立进程组，超时 / abort 时 SIGTERM 整组，1 s 后 SIGKILL。
 * - Windows：Git Bash（`AMA_HOOK_SHELL` 或常见安装位置）→ 否则 `cmd /d /s /c`。
 * - cwd 为会话 cwd；stdin 写完 JSON 即关闭（Hook 不读 stdin 时忽略 EPIPE）。
 * - stdout / stderr 各收集上限 1 MiB，超出截断。
 * - 同一事件的多条 Hook 并行启动，结果按配置顺序返回。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LoadedHook } from "./config.js";
import { hookEnv, parseHookOutput } from "./protocol.js";
import type { HookInput, HookRunResult } from "./types.js";

export const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 1_000;

export interface ShellCommand {
  file: string;
  args: string[];
  /** Windows cmd 需要原样传参。 */
  verbatim: boolean;
}

/** 选择 shell 并拼装参数。 */
export function shellFor(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ShellCommand {
  if (platform !== "win32") return { file: "/bin/sh", args: ["-c", command], verbatim: false };
  const candidates = [
    env["AMA_HOOK_SHELL"],
    env["ProgramFiles"] && join(env["ProgramFiles"], "Git", "bin", "bash.exe"),
    env["ProgramW6432"] && join(env["ProgramW6432"], "Git", "bin", "bash.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate))
      return { file: candidate, args: ["-c", command], verbatim: false };
  }
  return {
    file: env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
    verbatim: true,
  };
}

export interface RunHookOptions {
  cwd: string;
  /** 叠加到 process.env 之上的环境。 */
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal | undefined;
}

class Collector {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  push(chunk: Buffer): void {
    if (this.size >= MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    const room = MAX_OUTPUT_BYTES - this.size;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程已退出
    }
  }
}

/** 运行一条 Hook 命令；不抛错（spawn 失败记为退出码 127 + stderr）。 */
export function runHookCommand(
  hook: Pick<LoadedHook, "event" | "command" | "timeoutMs" | "source">,
  input: HookInput,
  options: RunHookOptions,
): Promise<HookRunResult> {
  const started = Date.now();
  const shell = shellFor(hook.command);
  return new Promise<HookRunResult>((resolveResult) => {
    const stdout = new Collector();
    const stderr = new Collector();
    let timedOut = false;
    let settled = false;
    const child = spawn(shell.file, shell.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, ...hookEnv(input) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: shell.verbatim,
    });

    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      killTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killTree(child.pid, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, hook.timeoutMs);
    const onAbort = (): void => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, extraStderr?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const out = stdout.text();
      const result: HookRunResult = {
        event: hook.event,
        command: hook.command,
        source: hook.source,
        exitCode: timedOut ? null : exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout: out,
        stderr: stderr.text() + (extraStderr ?? ""),
      };
      if (!timedOut && exitCode === 0) {
        const parsed = parseHookOutput(out);
        if (parsed.output !== undefined) result.output = parsed.output;
      }
      resolveResult(result);
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(127, `${error.message}\n`));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {
      // Hook 没读 stdin 就退出：EPIPE 无害。
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

/** 并行运行，结果按入参顺序返回。 */
export function runHooks(
  hooks: readonly Pick<LoadedHook, "event" | "command" | "timeoutMs" | "source">[],
  input: HookInput,
  options: RunHookOptions,
): Promise<HookRunResult[]> {
  return Promise.all(hooks.map((hook) => runHookCommand(hook, input, options)));
}
