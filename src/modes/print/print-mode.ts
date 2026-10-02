/**
 * print 模式（`ama -p`，设计 §11.1 第 15–16 步）。[B6]
 *
 * - 提示 = 位置参数 + stdin 管道（stdin 非 TTY 时读到 EOF），两者都有时空一行拼接；都没有 → 用法错误 2。
 * - `--output-format text`（缺省）：运行结束后输出最后一条助手文本；`json`：一个结果对象（文本、
 *   停止原因、用量、缓存命中率、全部条目）；`stream-json`：每个会话事件一行（线上形状同 RPC）。
 * - 无人值守：ask → deny（bootstrap 已按 print 设 unattended）。
 * - 退出码：最终助手消息 `error / aborted` 或提示被拒 → 1；SIGINT 130、SIGTERM 143（先 abort）。
 */

import type { ModeContext } from "../../cli/deps.js";
import { currentSession } from "../../cli/compose-session.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import { errorText, lastAssistant, onStdoutClosed, onTerminationSignals } from "../shared.js";
import { toJsonLine, toWireEvent } from "./json-event.js";

export function joinPrompt(argument: string | undefined, piped: string): string {
  const parts = [argument ?? "", piped.replace(/\s+$/, "")].filter((p) => p.trim() !== "");
  return parts.join("\n\n");
}

export async function runPrintMode(runtime: Runtime, context: ModeContext): Promise<number> {
  const { io } = context;
  const format = context.args.outputFormat ?? "text";
  const piped = io.stdinIsTTY ? "" : await io.readStdin();
  const prompt = joinPrompt(context.prompt, piped);
  if (prompt === "") {
    io.stderr("ama: -p 需要提示（位置参数或 stdin 管道）\n");
    return ExitCode.Usage;
  }
  const session = currentSession(runtime);
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
    await session.prompt(prompt);
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
