/**
 * print 模式（`ama -p`，设计 §11.1 第 15–16 步）。[B6]
 *
 * - 提示 = 位置参数 + stdin，两者都有时空一行拼接；都没有 → 用法错误 2。stdin 只在以下情况读到 EOF：
 *   没有提示参数、显式写了位置参数 `-`、或 stdin 是普通文件 / 空设备（读了不会卡）。有提示参数时不等
 *   管道（父进程留着不关的 stdin 不再让 `-p` 挂起）；shell 管道被跳过时 stderr 提示加 `-`。等 stdin
 *   超过 3 s 时 stderr 提示一次正在等待。
 * - 图片：`--image`（可重复）与提示里的 `@图片路径` / 图片文件路径作为附件（modes/image-input.ts）；
 *   显式附件遇到当前模型不收图片、文件不存在或超限 → 用法错误 2，不发请求。
 * - `--output-format text`（缺省）：运行结束后输出最后一条助手文本；`json`：一个结果对象（文本、
 *   停止原因、用量、缓存命中率、[W3-C2] `cache` 统计（同 `get_session_stats.cache`）、全部条目）；
 *   `stream-json`：每个会话事件一行（线上形状同 RPC，含 `cache_miss` / `cache_warm` /
 *   `context_pressure`）。
 * - 无人值守：ask → deny（bootstrap 已按 print 设 unattended）。
 * - 退出码：最终助手消息 `error / aborted` 或提示被拒 → 1；SIGINT 130、SIGTERM 143（先 abort）。
 */

import type { CliIo, ModeContext } from "../../cli/deps.js";
import { currentSession } from "../../cli/compose-session.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import { errorText, lastAssistant, onStdoutClosed, onTerminationSignals } from "../shared.js";
import { toJsonLine, toWireEvent } from "./json-event.js";
import type { ImageBlock } from "../../ai/types.js";
import { promptImages, sessionModel } from "../image-input.js";

export function joinPrompt(argument: string | undefined, piped: string): string {
  const parts = [argument ?? "", piped.replace(/\s+$/, "")].filter((p) => p.trim() !== "");
  return parts.join("\n\n");
}

/** 等 stdin 多久后提示一次「正在等待」。 */
export const STDIN_WAIT_HINT_MS = 3_000;

/** 按上面的规则决定读不读 stdin；读的时候超过 3 s 提示一次。 */
export async function readPromptStdin(
  io: CliIo,
  prompt: string | undefined,
  explicit: boolean,
  hintMs = STDIN_WAIT_HINT_MS,
): Promise<string> {
  if (io.stdinIsTTY) return "";
  const kind = io.stdinKind?.() ?? "other";
  const safe = kind === "file" || kind === "null";
  if (prompt !== undefined && prompt !== "" && !explicit && !safe) {
    if (kind === "fifo")
      io.stderr(
        "ama: 已有提示参数，未读取 stdin 管道；要拼接管道内容请在末尾加 -（如 cat 文件 | ama -p 总结 -）\n",
      );
    return "";
  }
  const timer = safe
    ? undefined
    : setTimeout(
        () => io.stderr("ama: 正在等待 stdin 输入结束（Ctrl+D 结束；提示也可以直接写成参数）…\n"),
        hintMs,
      );
  try {
    return await io.readStdin();
  } finally {
    clearTimeout(timer);
  }
}

export async function runPrintMode(runtime: Runtime, context: ModeContext): Promise<number> {
  const { io } = context;
  const format = context.args.outputFormat ?? "text";
  const piped = await readPromptStdin(io, context.prompt, context.args.stdin === true);
  const prompt = joinPrompt(context.prompt, piped);
  if (prompt === "") {
    io.stderr("ama: -p 需要提示（位置参数或 stdin 管道）\n");
    return ExitCode.Usage;
  }
  const session = currentSession(runtime);
  let images: ImageBlock[];
  try {
    images = await promptImages(
      prompt,
      context.args.images,
      io.cwd,
      sessionModel(runtime.providers, session),
    );
  } catch (error) {
    io.stderr(`ama: ${errorText(error)}\n`);
    return ExitCode.Usage;
  }
  const unsubscribe =
    format === "stream-json"
      ? session.subscribe((event) => io.stdout(`${toJsonLine(toWireEvent(event))}\n`))
      : () => undefined;
  let signalled: number | undefined;
  const offSignals = onTerminationSignals((code) => {
    signalled ??= code;
    void session.abort();
  });
  let stdoutClosed = false;
  const offEpipe = onStdoutClosed(() => {
    stdoutClosed = true;
    void session.abort();
  });
  let failure: string | undefined;
  try {
    await session.prompt(prompt, images.length > 0 ? { images } : {});
  } catch (error) {
    failure = errorText(error);
  } finally {
    offSignals();
    offEpipe();
    unsubscribe();
  }
  const last = lastAssistant(session);
  const text = session.getLastAssistantText() ?? "";
  const stopReason = failure !== undefined ? "error" : (last?.stopReason ?? "stop");
  if (format === "text") {
    // 部分模型在正文前多发空行：只去前导空行，保留首行缩进；json / stream-json 原样。
    const shown = text.replace(/^\s*\n/, "");
    if (shown !== "" && last?.stopReason !== "error")
      io.stdout(shown.endsWith("\n") ? shown : `${shown}\n`);
  } else if (format === "json") {
    const stats = session.getStats();
    io.stdout(
      `${toJsonLine({
        type: "result",
        sessionId: session.state.sessionId,
        sessionFile: session.state.sessionFile,
        model: session.state.model,
        stopReason,
        text,
        ...(failure !== undefined || last?.errorMessage !== undefined
          ? { error: failure ?? last?.errorMessage }
          : {}),
        usage: stats.tokens,
        cost: stats.cost,
        cacheHitRate: stats.cacheHitRate,
        ...(stats.cache !== undefined ? { cache: stats.cache } : {}),
        entries: session.entries,
      })}\n`,
    );
  }
  if (signalled !== undefined) return signalled;
  if (stdoutClosed) return ExitCode.Ok; // 下游（如 `| head`）已拿够输出
  if (failure !== undefined) {
    io.stderr(`ama: ${failure}\n`);
    return ExitCode.RuntimeError;
  }
  if (last?.stopReason === "error" || last?.stopReason === "aborted") {
    io.stderr(`ama: ${last.errorMessage ?? "模型调用失败"}\n`);
    return ExitCode.RuntimeError;
  }
  return ExitCode.Ok;
}
