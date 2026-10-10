/**
 * `ama sessions trace <id|文件>`：会话轨迹导出（docs/history/wave6-plan.md §2.5、D7）。[W6-T2]
 *
 * - 缺省 / `--html [文件]` / `--format html`：自包含 HTML（`trace/html.ts`）；`--json` / `--format json`：与 RPC
 *   `get_trace` 同形的 JSON（全部回合、已加载子会话、`previews` 只含本会话节点；`--no-content` 时没有）。
 * - 输出：`--html <文件>` 或 `--output <文件>` 写文件（0600），否则 stdout；`--open` 写好后用系统浏览器打开
 *   （没给文件时写到临时目录）。
 * - `--branch leaf|all`、`--no-content`（只留结构与数字）、`--children`（HTML 内嵌子会话预览）、
 *   `--now <ms>`（生成时间，确定性）。
 * - 只读：不加锁、不改会话文件（推算出的时间不写回）；子会话缺失只标 childMissing。
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome, resolveDataDir } from "../../config/paths.js";
import { msg } from "../../i18n/index.js";
import { findSessionFileReadOnly, readSessionReadOnly } from "../../session/scan.js";
import { buildTrace, type TraceInput } from "../../trace/build.js";
import { entryLookup } from "../../trace/detail.js";
import { renderTraceHtml } from "../../trace/html.js";
import { queryTrace } from "../../trace/query.js";
import { childLoader } from "../../trace/session.js";
import { AMA_VERSION } from "../../version.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";

export function sessionsTraceUsage(): string {
  return msg().trace.cli.usage;
}

export interface SessionsTraceDeps {
  /** 打开浏览器（测试替身；缺省 detached spawn）。 */
  open?: (command: OpenCommand) => Promise<void>;
  /** 生成时间（缺省 `Date.now()`；`--now` 优先）。 */
  now?: () => number;
  platform?: NodeJS.Platform;
  /** 读子会话（测试替身）。 */
  readChild?: (file: string) => TraceInput | undefined;
}

export interface OpenCommand {
  command: string;
  args: string[];
}

/** 各平台「用缺省程序打开文件」的命令。 */
export function openCommand(platform: NodeJS.Platform, file: string): OpenCommand {
  if (platform === "darwin") return { command: "open", args: [file] };
  if (platform === "win32") return { command: "explorer", args: [file] };
  return { command: "xdg-open", args: [file] };
}

function spawnOpen({ command, args }: OpenCommand): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });
}

/** `--html [文件]`：值可省略，只在下一个参数像 HTML 文件名时才当作文件。 */
function splitHtmlFlag(argv: readonly string[]): { rest: string[]; html: boolean; file?: string } {
  const rest: string[] = [];
  let html = false;
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token.startsWith("--html=")) {
      html = true;
      file = token.slice("--html=".length) || undefined;
    } else if (token === "--html") {
      html = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && /\.html?$/i.test(next)) {
        file = next;
        i++;
      }
    } else rest.push(token);
  }
  return { rest, html, ...(file !== undefined ? { file } : {}) };
}

function locate(io: CliIo, target: string, dirFlag: string | undefined): string {
  const asPath = resolve(io.cwd, expandHome(target, { env: io.env }));
  if (/[\\/]|\.jsonl$/.test(target) && existsSync(asPath)) return asPath;
  const root =
    dirFlag !== undefined
      ? resolve(io.cwd, expandHome(dirFlag, { env: io.env }))
      : join(resolveDataDir({ env: io.env }), "sessions");
  return findSessionFileReadOnly(root, target, io.cwd);
}

export async function runSessionsTrace(
  argv: readonly string[],
  io: CliIo,
  deps: SessionsTraceDeps = {},
): Promise<number> {
  const common = msg().subcommands.common;
  const m = msg().trace.cli;
  const split = splitHtmlFlag(argv);
  const { positionals, values, flags } = parseSubArgs(
    split.rest,
    ["format", "output", "branch", "session-dir", "now"],
    ["json", "open", "no-content", "children"],
  );
  if (flags.has("help")) {
    io.stdout(sessionsTraceUsage());
    return ExitCode.Ok;
  }
  const [target, extra] = positionals;
  if (target === undefined)
    throw new UsageError(common.needsArg("ama sessions trace", "<id|file>"));
  if (extra !== undefined) throw new UsageError(common.extraArgs(extra));
  const formatFlag = values.get("format");
  if (formatFlag !== undefined && formatFlag !== "html" && formatFlag !== "json")
    throw new UsageError(common.invalidChoice("--format", ["html", "json"], formatFlag));
  const wantsJson = flags.has("json") || formatFlag === "json";
  if (wantsJson && (split.html || formatFlag === "html")) throw new UsageError(m.formatConflict);
  const branch = values.get("branch") ?? "leaf";
  if (branch !== "leaf" && branch !== "all")
    throw new UsageError(common.invalidChoice("--branch", ["leaf", "all"], branch));
  const rawNow = values.get("now");
  const nowFlag = rawNow === undefined ? undefined : Number(rawNow);
  if (nowFlag !== undefined && (!Number.isInteger(nowFlag) || nowFlag < 0))
    throw new UsageError(m.badNow(rawNow ?? ""));
  const content = !flags.has("no-content");

  const file = locate(io, target, values.get("session-dir"));
  const read = readSessionReadOnly(file);
  const input: TraceInput = {
    header: read.header,
    entries: read.entries,
    leaf: read.leaf,
    sessionFile: file,
  };
  const loadChild = childLoader(deps.readChild);
  const base = nowFlag !== undefined ? { now: nowFlag } : {};
  let text: string;
  if (wantsJson) {
    const result = queryTrace(
      input,
      { branch, content: content ? "preview" : "none" },
      { loadChild, loadChildren: true, unlimited: true, ...base },
    );
    text = `${JSON.stringify(result, null, 2)}\n`;
  } else {
    const trace = buildTrace(input, { branch, loadChild, ...base });
    const children = loadChild.inputs().flatMap((i) => i.entries);
    text = renderTraceHtml(trace, {
      content,
      children: flags.has("children"),
      generatedAt: nowFlag ?? (deps.now ?? Date.now)(),
      version: AMA_VERSION,
      lookup: entryLookup([...input.entries, ...children], read.header.cwd),
    });
  }

  const outFlag = split.file ?? values.get("output");
  const open = flags.has("open");
  let outPath =
    outFlag === undefined ? undefined : resolve(io.cwd, expandHome(outFlag, { env: io.env }));
  if (outPath === undefined && open)
    outPath = join(tmpdir(), `ama-trace-${read.header.id}.${wantsJson ? "json" : "html"}`);
  if (outPath === undefined) {
    io.stdout(text);
    return ExitCode.Ok;
  }
  writeFileSync(outPath, text, { mode: 0o600 });
  io.stderr(m.wrote(outPath));
  if (open) {
    try {
      await (deps.open ?? spawnOpen)(openCommand(deps.platform ?? process.platform, outPath));
    } catch (error) {
      io.stderr(m.openFailed(error instanceof Error ? error.message : String(error)));
      return ExitCode.RuntimeError;
    }
  }
  return ExitCode.Ok;
}
