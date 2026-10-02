#!/usr/bin/env node
/**
 * bin 入口（设计 §11.1 第 1–2 步）。[B5]
 *
 * - 设 `AMA=1`、`AI_AGENT=ama`；直接执行时装 `uncaughtException` / `unhandledRejection` →
 *   stderr 一行 + 退出码 1；SIGINT / SIGTERM 交给当前模式。
 * - `--version` / `--help` 短路；子命令 `auth / sessions / models / providers / doctor / config /
 *   init` 分派后返回；进入对话的命令（与 `providers add`）启动前若配置目录不存在则静默初始化
 *   （`AMA_NO_INIT=1` 关闭），只读子命令（`config show`、`doctor`、`models list` 等）不写配置目录；
 *   其余交给 `runCli()`（bootstrap → 模式）。
 * - 设了 HTTPS_PROXY / HTTP_PROXY 时启用 Node 内置的环境变量代理（cli/proxy.ts）；不支持的 Node
 *   版本在会联网的命令里提示一次。
 * - 运行时实现（RuntimeDeps）：`MainOptions.deps` > `registerRuntimeDeps()` > 组装根
 *   `createRuntimeDeps()`（cli/compose.ts，动态 import）。
 * - 签名 `main(argv): Promise<number>` 与「直接执行才自动运行」判定保持不变：
 *   src/bundle.ts 显式调用 `main()`。
 * - [W6-C0] 界面语言在解析参数后、任何输出前定一次：`AMA_LANG` > `--lang` > 用户级 `ui.language` >
 *   `LC_ALL` / `LC_MESSAGES` / `LANG`（docs/i18n.md）；profile / 项目级的 `ui.language` 由 bootstrap 合并后补定。
 */

import { fstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AMA_VERSION } from "../version.js";
import { parseArgs } from "./args.js";
import { reportError, runCli } from "./bootstrap.js";
import type { CliIo, RuntimeDeps, StdinKind } from "./deps.js";
import { ExitCode } from "./exit-codes.js";
import { runAuth } from "./subcommands/auth.js";
import { runConfig } from "./subcommands/config.js";
import { runDoctor } from "./subcommands/doctor.js";
import { runModels } from "./subcommands/models.js";
import { runProviders } from "./subcommands/providers.js";
import { runInit } from "./subcommands/init.js";
import { autoInitConfigDir } from "../config/init.js";
import { resolveConfigDir } from "../config/paths.js";
import { runSessions } from "./subcommands/sessions.js";
import { runStats } from "./subcommands/stats.js";
import { enableEnvProxy, proxyHint } from "./proxy.js";
import { msg, resolveLocale, setLocale, type LanguageSetting } from "../i18n/index.js";

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

/** fd 0 的类型；fstat 失败（已关闭）按 `null` 处理。 */
export function stdinKindDefault(): StdinKind {
  try {
    const stat = fstatSync(0);
    if (stat.isFile()) return "file";
    if (stat.isFIFO()) return "fifo";
    if (stat.isSocket()) return "socket";
    if (stat.isCharacterDevice()) return process.stdin.isTTY === true ? "tty" : "null";
    return "other";
  } catch {
    return "null";
  }
}

/** 等 stdin 首字节至多 `timeoutMs`；超时则停止读取并返回 undefined，否则读到 EOF。 */
export function readStdinFirstByteDefault(timeoutMs: number): Promise<string | undefined> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      clearTimeout(timer);
      timer = undefined;
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    timer = setTimeout(() => {
      cleanup();
      // 不再读：释放句柄，父进程留着不关的管道不会让进程挂住
      stdin.pause();
      stdin.destroy();
      resolve(undefined);
    }, timeoutMs);
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
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
    readStdinFirstByte: readStdinFirstByteDefault,
    stdinKind: stdinKindDefault,
  };
}

/** 用户级 config.json 的 `ui.language`（只读、不校验、读不到当未设；完整校验在 bootstrap）。 */
export function peekUserLanguage(env: NodeJS.ProcessEnv): LanguageSetting | undefined {
  try {
    const raw = readFileSync(join(resolveConfigDir({ env }), "config.json"), "utf8");
    const value = (JSON.parse(raw) as { ui?: { language?: unknown } }).ui?.language;
    return value === "auto" || value === "zh" || value === "en" ? value : undefined;
  } catch {
    return undefined;
  }
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
  // io 交给组装根决定启动期问答（迷你 TUI / 文本 / 不问）；--no-tui 在解析后才知道。
  let noTui = false;
  const resolveDeps = async (): Promise<RuntimeDeps> =>
    options.deps ??
    registeredDeps ??
    (await import("./compose.js")).createRuntimeDeps({
      env: io.env as NodeJS.ProcessEnv,
      io,
      noTui,
    });
  try {
    const parsed = parseArgs(argv);
    const cliLang = parsed.kind === "run" ? parsed.args.lang : parsed.lang;
    setLocale(resolveLocale(io.env, { language: peekUserLanguage(io.env) }, cliLang));
    if (parsed.kind !== "subcommand") noTui = parsed.args.noTui;
    const informational =
      parsed.kind === "run" ? parsed.args.help || parsed.args.version : parsed.name === "init";
    // 首次自动初始化只在会进入对话的命令（和接入供应商）里做；只读子命令不写配置目录
    const startsWork =
      parsed.kind === "run" || (parsed.name === "providers" && parsed.argv[0] === "add");
    if (!informational && startsWork) autoInitConfigDir(resolveConfigDir({ env: io.env }), io.env);
    // 进程级副作用（全局 dispatcher）：只在真正的进程入口做，测试里调 main() 不碰
    if (!informational && options.processHooks !== false) {
      const proxy = enableEnvProxy(io.env);
      const online =
        parsed.kind === "run" || parsed.name === "models" || parsed.name === "providers";
      const hint = online ? proxyHint(proxy) : undefined;
      if (hint !== undefined) io.stderr(hint);
    }
    if (parsed.kind === "subcommand") {
      switch (parsed.name) {
        case "auth":
          return await runAuth(parsed.argv, io);
        case "sessions":
          return await runSessions(parsed.argv, io, await resolveDeps());
        case "models":
          return await runModels(parsed.argv, io, await resolveDeps());
        case "providers":
          return await runProviders(parsed.argv, io, await resolveDeps());
        case "doctor":
          return await runDoctor(parsed.argv, io, await resolveDeps());
        case "config":
          return await runConfig(parsed.argv, io, await resolveDeps());
        case "init":
          return runInit(parsed.argv, io);
        case "stats":
          return await runStats(parsed.argv, io);
        case "memory":
          // [W6-C0] W6-M 换成 runMemory(parsed.argv, io, await resolveDeps())
          io.stderr(`${msg().cli.main.subcommandUnavailable(parsed.name)}\n`);
          return ExitCode.Usage;
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
