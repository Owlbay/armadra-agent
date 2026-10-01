#!/usr/bin/env node
/**
 * bin 入口（设计 §11.1 第 1–2 步）。[B5]
 *
 * - 设 `AMA=1`、`AI_AGENT=ama`；直接执行时装 `uncaughtException` / `unhandledRejection` →
 *   stderr 一行 + 退出码 1；SIGINT / SIGTERM 交给当前模式。
 * - `--version` / `--help` 短路；子命令 `auth / sessions / models / doctor / config` 分派后返回；
 *   其余交给 `runCli()`（bootstrap → 模式）。
 * - 运行时实现（RuntimeDeps）：`MainOptions.deps` > `registerRuntimeDeps()` > 组装根
 *   `createRuntimeDeps()`（cli/compose.ts，动态 import）。
 * - 签名 `main(argv): Promise<number>` 与「直接执行才自动运行」判定保持不变：
 *   src/bundle.ts 显式调用 `main()`。
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AMA_VERSION } from "../version.js";
import { parseArgs } from "./args.js";
import { reportError, runCli } from "./bootstrap.js";
import type { CliIo, RuntimeDeps } from "./deps.js";
import { ExitCode } from "./exit-codes.js";
import { runAuth } from "./subcommands/auth.js";
import { runConfig } from "./subcommands/config.js";
import { runDoctor } from "./subcommands/doctor.js";
import { runModels } from "./subcommands/models.js";
import { runSessions } from "./subcommands/sessions.js";

declare const __AMA_BUNDLED__: boolean | undefined;

let registeredDeps: RuntimeDeps | undefined;

/** 集成批次注入运行时实现（B1 / B2 / B3 / B6 / B7）。 */
export function registerRuntimeDeps(deps: RuntimeDeps | undefined): void {
  registeredDeps = deps;
}

export interface MainOptions {
  deps?: RuntimeDeps;
  io?: Partial<CliIo>;
  /** 装进程级异常处理器（缺省 true；测试传 false）。 */
  processHooks?: boolean;
}

/** 读 stdin 全部内容；TTY 下只读一行且不回显（auth set）。 */
export function readStdinDefault(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stdin.once("error", reject);
    });
  }
  return new Promise((resolve) => {
    let line = "";
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          resolve(line);
          return;
        }
        if (ch === "\u0003") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          resolve("");
          return;
        }
        if (ch === "\u007f" || ch === "\b") line = line.slice(0, -1);
        else line += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export function defaultIo(): CliIo {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    env: process.env,
    cwd: process.cwd(),
    readStdin: readStdinDefault,
  };
}

let hooksInstalled = false;

function installProcessHooks(io: CliIo): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const fatal = (error: unknown): void => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.stderr(`ama: 未捕获的异常：${message.split("\n")[0] ?? ""}\n`);
    process.exit(ExitCode.RuntimeError);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}

export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const io: CliIo = { ...defaultIo(), ...options.io };
  process.env["AMA"] = "1";
  process.env["AI_AGENT"] = "ama";
  const [first] = argv;
  if (argv.length === 1 && (first === "--version" || first === "-v")) {
    io.stdout(`${AMA_VERSION}\n`);
    return ExitCode.Ok;
  }
  if (options.processHooks !== false) installProcessHooks(io);
  // 缺省装配走动态 import：--version / auth 不加载运行时实现（bundle 里同样内联）。
  const resolveDeps = async (): Promise<RuntimeDeps> =>
    options.deps ??
    registeredDeps ??
    (await import("./compose.js")).createRuntimeDeps({ env: io.env as NodeJS.ProcessEnv });
  try {
    const parsed = parseArgs(argv);
    if (parsed.kind === "subcommand") {
      switch (parsed.name) {
        case "auth":
          return await runAuth(parsed.argv, io);
        case "sessions":
          return await runSessions(parsed.argv, io, await resolveDeps());
        case "models":
          return await runModels(parsed.argv, io, await resolveDeps());
        case "doctor":
          return await runDoctor(parsed.argv, io, await resolveDeps());
        case "config":
          return await runConfig(parsed.argv, io, await resolveDeps());
      }
    }
    if (parsed.args.version) {
      io.stdout(`${AMA_VERSION}\n`);
      return ExitCode.Ok;
    }
    if (parsed.args.help) return runCli(argv, undefined, io);
  } catch (error) {
    return reportError(error, io);
  }
  return runCli(argv, await resolveDeps(), io);
}

function isDirectRun(): boolean {
  if (typeof __AMA_BUNDLED__ !== "undefined" && __AMA_BUNDLED__) return false;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`ama: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = ExitCode.RuntimeError;
    },
  );
}
