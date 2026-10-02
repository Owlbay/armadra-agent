/**
 * 外部 Agent 子进程（docs/wave5-plan.md §5.4 看门狗 / 孤儿进程）。[W5-E]
 *
 * - POSIX 以 `detached` 自成进程组，结束时 `killProcessTree`（SIGTERM → 宽限 → SIGKILL）；
 *   登记到 `tools/process-tree.ts`，ama 退出时同步清掉仍存活的组。
 * - Windows 上 npm 装的 CLI 是 `.cmd` 垫片，Node 不允许直接 spawn，改经 `cmd.exe /d /s /c`。
 * - stderr 只保留尾部 8 KB 供诊断（不落盘、不进会话，§5.4 敏感数据）。
 * - 测试与宿主可注入 {@link SpawnTransport}（内存流），驱动不关心对端是不是真进程。
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  killProcessTree,
  trackProcessGroup,
  untrackProcessGroup,
  type ProcessDeps,
} from "../tools/process-tree.js";

export const STDERR_TAIL_BYTES = 8 * 1024;
/** 关 stdin 之后等进程自己退出的时间，过了再杀进程树。 */
export const STDIN_CLOSE_GRACE_MS = 2_000;

export interface TransportSpec {
  program: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentTransport {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly pid?: number;
  /** stderr 尾部（≤ 8 KB）。 */
  stderrTail(): string;
  /** 进程结束（退出码；信号退出为 null）。 */
  readonly exited: Promise<number | null>;
  /** 关 stdin → 等 `graceMs` → 杀进程树。幂等。 */
  terminate(graceMs?: number): Promise<void>;
}

export type SpawnTransport = (spec: TransportSpec) => AgentTransport;

export interface SpawnDeps {
  platform?: NodeJS.Platform;
  process?: ProcessDeps;
  /** 进程起来 / 结束时回调（pid 登记，§5.4 孤儿进程）。 */
  onSpawn?(pid: number, spec: TransportSpec): void;
  onExit?(pid: number): void;
}

function quoteCmd(arg: string): string {
  return /[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** Windows `.cmd` / `.bat` 垫片改经 cmd.exe；其余原样。 */
export function commandLine(
  spec: Pick<TransportSpec, "program" | "args" | "env">,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; verbatim: boolean } {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(spec.program)) {
    const shell = spec.env["ComSpec"] ?? spec.env["COMSPEC"] ?? "cmd.exe";
    const line = [spec.program, ...spec.args].map(quoteCmd).join(" ");
    return { file: shell, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
  }
  return { file: spec.program, args: [...spec.args], verbatim: false };
}

/** 起真实子进程。spawn 失败（程序不存在等）时 `exited` 以 -1 结束、stdout 立即结束。 */
export function spawnTransport(spec: TransportSpec, deps: SpawnDeps = {}): AgentTransport {
  const platform = deps.platform ?? process.platform;
  const line = commandLine(spec, platform);
  let tail = "";
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => (resolveExit = resolve));
  const child: ChildProcess = spawn(line.file, line.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: line.verbatim,
  });
  const pid = child.pid;
  if (pid !== undefined) {
    if (platform !== "win32") trackProcessGroup(pid);
    deps.onSpawn?.(pid, spec);
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  // 写一个已退出进程的 stdin 会 EPIPE；交给 exited 处理，不让它变成未捕获异常
  child.stdin?.on("error", () => undefined);
  child.on("error", (error) => {
    tail = `${tail}\n${error.message}`.slice(-STDERR_TAIL_BYTES);
    child.stdout?.destroy();
    finish(-1);
  });
  let done = false;
  const finish = (code: number | null): void => {
    if (done) return;
    done = true;
    if (pid !== undefined) {
      untrackProcessGroup(pid);
      deps.onExit?.(pid);
    }
    resolveExit(code);
  };
  child.on("close", (code) => finish(code));
  let terminating: Promise<void> | undefined;
  return {
    stdin: child.stdin as NodeJS.WritableStream,
    stdout: child.stdout as NodeJS.ReadableStream,
    ...(pid !== undefined ? { pid } : {}),
    stderrTail: () => tail,
    exited,
    terminate(graceMs = STDIN_CLOSE_GRACE_MS) {
      terminating ??= (async () => {
        if (done) return;
        child.stdin?.end();
        const timer = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), graceMs).unref(),
        );
        if ((await Promise.race([exited, timer])) !== "timeout") return;
        if (pid !== undefined) await killProcessTree(pid, { platform, ...deps.process });
        else child.kill("SIGKILL");
      })();
      return terminating;
    },
  };
}

/** 最近一段 stderr，单行化后截断（放进错误信息）。 */
export function stderrHint(transport: AgentTransport, max = 400): string {
  const text = transport.stderrTail().trim().replace(/\s+/g, " ");
  if (text === "") return "";
  return text.length > max ? `…${text.slice(-max)}` : text;
}
