/**
 * `bash` 工具（设计 §5.2、§4.2）。[B3]
 *
 * - `spawn(shell, args, { detached: !win, stdio: [ignore, pipe, pipe] })`，stdout / stderr 合流；
 * - 超时（缺省 120 s，上限 600 s）与 abort 都走 `killProcessTree`：SIGTERM → 2 s → SIGKILL；
 * - 滚动尾部节流后经 `ctx.onUpdate` 流出；超限（2000 行 / 50 KB）尾截断并落全文；
 * - 结构化结果 `{ output, exit_code, truncated, full_output_path?, wall_time_seconds }`；
 *   信号退出 `128 + signo`；非零退出码 → isError；
 * - 注入 `AMA_*` 环境变量（shell.ts）。shell 退出后不等仍占着管道的后台进程。
 * - [W5-H2] 后台命令（§8.3 H6，不加新工具）：`{ command, background: true }` 立即返回
 *   `{ jobId, outputPath, pid }`；`{ job, action: "wait" | "output" | "stop" }` 查询 / 结束
 *   （background-jobs.ts，按会话登记，会话 dispose 时回收进程树；退出经提醒通道通知）。
 * - **进程只在 `spawnShell` 里创建**（前台与后台共用；S2 的 bash 沙箱在这一处包一层）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { resolvePath } from "./paths.js";
import { buildShellArgs, buildToolEnv, resolveShell, type ShellConfig } from "./shell.js";
import {
  exitCodeOf,
  isGroupAlive,
  killProcessTree,
  trackProcessGroup,
  untrackProcessGroup,
  type ProcessDeps,
} from "./process-tree.js";
import { OutputAccumulator } from "./output-accumulator.js";
import { formatSize, resolveOutputDir, safeFileName } from "./truncate.js";
import { jobsForSession, type BackgroundJobs, type Job } from "./background-jobs.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
const UPDATE_THROTTLE_MS = 100;
/** shell 退出后等管道关闭的上限（后台子进程可能一直占着）。 */
const STDIO_DRAIN_MS = 200;

export interface BashInput {
  /** 前台 / 后台命令；查询后台任务时不给。 */
  command?: string;
  timeoutMs?: number;
  cwd?: string;
  description?: string;
  /** [W5-H2] 后台运行：立即返回 jobId。 */
  background?: boolean;
  /** [W5-H2] 后台任务 id（与 action 一起用）。 */
  job?: string;
  action?: "wait" | "output" | "stop";
}

/** [W5-H2] `wait` 的缺省等待（毫秒）。 */
export const DEFAULT_JOB_WAIT_MS = 30_000;

export interface BackgroundStart {
  jobId: string;
  outputPath: string;
  pid?: number;
}

export interface BashStructured {
  output: string;
  exit_code: number;
  truncated: boolean;
  full_output_path?: string;
  wall_time_seconds: number;
}

export interface BashDetails extends BashStructured {
  timedOut: boolean;
  aborted: boolean;
  killedWithSigkill: boolean;
  totalLines: number;
  totalBytes: number;
  cwd: string;
  description?: string;
}

export interface BashToolOptions {
  /** config.tools.bashTimeoutMs；缺省 120 000。 */
  defaultTimeoutMs?: number;
  /** 测试注入：固定 shell 选择。 */
  shell?(): ShellConfig;
  /** 测试注入：杀树参数（宽限时间等）。 */
  processDeps?: ProcessDeps;
  /** 测试注入：基础环境，缺省 process.env。 */
  baseEnv?(): NodeJS.ProcessEnv;
  /** 测试注入：会话的后台任务表，缺省按会话 id 登记（background-jobs.ts）。 */
  jobs?(sessionId: string): BackgroundJobs;
}

export interface SpawnShellOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** POSIX 自成进程组（杀树用）；Windows 为 false。 */
  detached: boolean;
  /** 前台 `["ignore", "pipe", "pipe"]`；后台把输出文件描述符直接交给子进程。 */
  stdio: ["ignore", "pipe" | number, "pipe" | number];
}

/**
 * bash 工具唯一的进程创建点（前台 / 后台共用）。之后的 OS 沙箱（S2 第二阶段）在这里包一层即可。
 */
export function spawnShell(
  shell: ShellConfig,
  command: string,
  options: SpawnShellOptions,
): ChildProcess {
  return spawn(shell.shell, buildShellArgs(shell, command), {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: options.stdio,
    windowsHide: true,
  });
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** 等 shell 退出；之后最多再等 STDIO_DRAIN_MS 让管道读完，再强制关闭。 */
function waitForExit(child: ChildProcess): Promise<ExitInfo> {
  return new Promise((resolve, reject) => {
    let exit: ExitInfo | undefined;
    let settled = false;
    const done = () => {
      if (settled || exit === undefined) return;
      settled = true;
      resolve(exit);
    };
    child.once("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once("close", (code, signal) => {
      exit ??= { code, signal };
      done();
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done();
      }, STDIO_DRAIN_MS).unref();
    });
  });
}

export async function executeBash(
  input: BashInput,
  ctx: ToolContext,
  options: BashToolOptions = {},
): Promise<ToolResult> {
  if (input.job !== undefined) return jobAction(input, ctx, options);
  if (input.action !== undefined) return fail("action needs job (a background job id)");
  if (typeof input.command !== "string" || input.command.trim() === "") {
    return fail("command must be a non-empty string");
  }
  const command = input.command;
  const timeoutMs = input.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BASH_TIMEOUT_MS) {
    return fail(`timeoutMs must be between 1 and ${MAX_BASH_TIMEOUT_MS}`);
  }
  const cwd = resolvePath(input.cwd ?? ".", ctx.cwd);
  try {
    if (!(await stat(cwd)).isDirectory())
      return fail(`Working directory is not a directory: ${cwd}`);
  } catch {
    return fail(`Working directory does not exist: ${cwd}`);
  }
  if (ctx.signal.aborted) return fail("aborted by user");

  const shell = options.shell ? options.shell() : resolveShell();
  const env = buildToolEnv(options.baseEnv ? options.baseEnv() : process.env, {
    sessionId: ctx.sessionId,
    sessionFile: ctx.sessionFile,
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    thinkingLevel: ctx.thinkingLevel,
    depth: ctx.depth,
  });
  const isWindows = (options.processDeps?.platform ?? process.platform) === "win32";
  if (input.background === true)
    return startBackground(command, { cwd, env, shell, isWindows }, ctx, options);
  const started = Date.now();
  const acc = new OutputAccumulator({
    spillPath: () =>
      join(resolveOutputDir(ctx.outputDir), safeFileName(`bash-${ctx.toolCallId}.log`)),
  });

  let child: ChildProcess;
  try {
    child = spawnShell(shell, command, {
      cwd,
      env,
      detached: !isWindows,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return fail(`Failed to start shell ${shell.shell}: ${(err as Error).message}`);
  }
  const pid = child.pid;
  if (pid !== undefined && !isWindows) trackProcessGroup(pid);

  let lastUpdate = 0;
  let pendingUpdate: NodeJS.Timeout | undefined;
  const emitUpdate = () => {
    pendingUpdate = undefined;
    lastUpdate = Date.now();
    ctx.onUpdate(acc.tail());
  };
  const onData = (chunk: Buffer) => {
    acc.append(chunk);
    if (pendingUpdate) return;
    const wait = Math.max(0, lastUpdate + UPDATE_THROTTLE_MS - Date.now());
    pendingUpdate = setTimeout(emitUpdate, wait);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  let timedOut = false;
  let aborted = false;
  let killing: Promise<boolean> | undefined;
  const kill = () => {
    if (pid === undefined) return;
    killing ??= killProcessTree(pid, options.processDeps);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  let exit: ExitInfo;
  try {
    exit = await waitForExit(child);
  } catch (err) {
    return fail(`Failed to run command with ${shell.shell}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    if (pendingUpdate) {
      // 冲掉节流中的最后一次更新，保证 UI 看到的尾部是完整的。
      clearTimeout(pendingUpdate);
      emitUpdate();
    }
  }
  const killedWithSigkill = killing ? await killing : false;
  // 后台子进程仍在组里时保持登记，进程退出时一并清理。
  if (pid !== undefined && !isWindows && !isGroupAlive(pid)) untrackProcessGroup(pid);

  const out = acc.finish();
  const exitCode = exitCodeOf(exit.code, exit.signal);
  const wall = Math.round((Date.now() - started) / 10) / 100;
  const structured: BashStructured = {
    output: out.output,
    exit_code: exitCode,
    truncated: out.truncated,
    ...(out.fullOutputPath !== undefined ? { full_output_path: out.fullOutputPath } : {}),
    wall_time_seconds: wall,
  };
  const details: BashDetails = {
    ...structured,
    timedOut,
    aborted,
    killedWithSigkill,
    totalLines: out.totalLines,
    totalBytes: out.totalBytes,
    cwd,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };

  const parts: string[] = [out.output === "" ? "(no output)" : out.output];
  if (out.truncated) {
    const where = out.fullOutputPath ? ` Full output: ${out.fullOutputPath}` : "";
    parts.push(
      `[Output truncated: showing the last ${out.outputLines} of ${out.totalLines} lines ` +
        `(${formatSize(out.totalBytes)} total).${where}]`,
    );
  }
  if (aborted) parts.push("aborted by user");
  else if (timedOut) parts.push(`[Command timed out after ${timeoutMs} ms and was killed]`);
  if (exitCode !== 0) parts.push(`[exit code: ${exitCode}]`);
  return {
    content: parts.join("\n\n"),
    isError: exitCode !== 0 || timedOut || aborted,
    structured,
    details,
  };
}

// ---------------------------------------------------------------------------
// [W5-H2] 后台命令
// ---------------------------------------------------------------------------

function jobsOf(ctx: ToolContext, options: BashToolOptions): BackgroundJobs {
  return options.jobs ? options.jobs(ctx.sessionId) : jobsForSession(ctx.sessionId);
}

function startBackground(
  command: string,
  spawnInfo: { cwd: string; env: NodeJS.ProcessEnv; shell: ShellConfig; isWindows: boolean },
  ctx: ToolContext,
  options: BashToolOptions,
): ToolResult {
  const { cwd, env, shell, isWindows } = spawnInfo;
  const outputPath = join(
    resolveOutputDir(ctx.outputDir),
    safeFileName(`bash-bg-${ctx.toolCallId}.log`),
  );
  let job: Job;
  try {
    job = jobsOf(ctx, options).start(command, {
      cwd,
      outputPath,
      ...(options.processDeps === undefined ? {} : { processDeps: options.processDeps }),
      spawn: (fd) =>
        spawnShell(shell, command, { cwd, env, detached: !isWindows, stdio: ["ignore", fd, fd] }),
    });
  } catch (err) {
    return fail(`Failed to start shell ${shell.shell}: ${(err as Error).message}`);
  }
  const structured: BackgroundStart = { jobId: job.id, outputPath: job.outputPath };
  if (job.pid !== undefined) structured.pid = job.pid;
  return {
    content:
      `Started background job ${job.id}${job.pid !== undefined ? ` (pid ${job.pid})` : ""}; ` +
      `output: ${job.outputPath}. Check it with bash {"job":"${job.id}","action":"wait"|"output"|"stop"}; ` +
      "you will be told when it exits.",
    structured,
    details: { ...structured, background: true, command, cwd },
  };
}

function jobStatusLine(job: Job): string {
  const state =
    job.status === "running"
      ? "still running"
      : job.status === "stopped"
        ? `stopped (exit code ${job.exitCode ?? "?"})`
        : `exited with code ${job.exitCode ?? "?"}`;
  return `[job ${job.id} ${state}; output: ${job.outputPath}]`;
}

async function jobAction(
  input: BashInput,
  ctx: ToolContext,
  options: BashToolOptions,
): Promise<ToolResult> {
  const id = input.job as string;
  if (input.command !== undefined || input.background === true)
    return fail("job queries take only job, action and timeoutMs");
  const action = input.action ?? "output";
  const jobs = jobsOf(ctx, options);
  if (jobs.get(id) === undefined) {
    const known = jobs.list().map((job) => job.id);
    return fail(
      `Unknown background job ${id}${known.length > 0 ? ` (jobs: ${known.join(", ")})` : ""}`,
    );
  }
  if (action === "stop") {
    const job = (await jobs.stop(id)) as Job;
    const out = jobs.output(id);
    const text = out?.content ?? "";
    return {
      content: `${text === "" ? "(no output)" : text}\n\n${jobStatusLine(job)}`,
      structured: { jobId: id, status: job.status, exit_code: job.exitCode ?? null },
    };
  }
  if (action === "wait") {
    const waitMs = input.timeoutMs ?? DEFAULT_JOB_WAIT_MS;
    if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > MAX_BASH_TIMEOUT_MS)
      return fail(`timeoutMs must be between 1 and ${MAX_BASH_TIMEOUT_MS}`);
    await jobs.wait(id, waitMs, ctx.signal);
  }
  const out = jobs.output(id);
  if (out === undefined) return fail(`Unknown background job ${id}`);
  const job = out.job;
  if (job.status !== "running") jobs.markSeen(id);
  const parts = [out.content === "" ? "(no output)" : out.content];
  if (out.truncated)
    parts.push(
      `[Output truncated: showing the last ${out.outputLines} of ${out.totalLines} lines ` +
        `(${formatSize(out.totalBytes)} total). Full output: ${job.outputPath}]`,
    );
  parts.push(jobStatusLine(job));
  return {
    content: parts.join("\n\n"),
    isError: job.status === "exited" && job.exitCode !== 0,
    structured: { jobId: id, status: job.status, exit_code: job.exitCode ?? null },
  };
}

export function createBashTool(options: BashToolOptions = {}): ToolDefinition<BashInput> {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a shell command; stdout+stderr combined, keeps the last 2000 lines / 50 KB (full " +
      `output saved). Timeout ${DEFAULT_BASH_TIMEOUT_MS / 1000} s, max ${MAX_BASH_TIMEOUT_MS / 1000} s. ` +
      "background:true gives a job id for {job, action}.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer" },
        cwd: { type: "string", description: "Default: session cwd" },
        description: { type: "string" },
        background: { type: "boolean" },
        job: { type: "string" },
        action: { type: "string", enum: ["wait", "output", "stop"] },
      },
      additionalProperties: false,
    },
    permission: "execute",
    executionMode: "sequential",
    annotations: { destructive: true, openWorld: true },
    promptSnippet: "bash: run shell commands (AMA_* env vars describe the session)",
    execute: (input, ctx) => executeBash(input, ctx, options),
  };
}
