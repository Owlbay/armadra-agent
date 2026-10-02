/**
 * print 模式（`ama -p`，设计 §11.1 第 15–16 步）。[B6]
 *
 * - 提示 = 位置参数 + stdin，两者都有时空一行拼接；都没有 → 用法错误 2。stdin 的读法：
 *   - 没有提示参数，或显式写了位置参数 `-`：读到 EOF（超过 3 s 时 stderr 提示一次正在等待）；
 *   - 有提示参数且 stdin 是管道（shell 管道或父进程留的管道）：等首字节，`AMA_STDIN_WAIT_MS`
 *     （缺省 2000，0 = 不等）内一个字节都没有 → 忽略 stdin 并在 stderr 提示；收到首字节后读到 EOF；
 *   - stdin 是普通文件 / 空设备：直接读（不会卡）；TTY 或 `--no-stdin`：不读。
 * - 图片：`--image`（可重复）与提示里的 `@图片路径` / 图片文件路径作为附件（modes/image-input.ts）；
 *   显式附件遇到当前模型不收图片、文件不存在或超限 → 用法错误 2，不发请求。
 * - `--output-format text`（缺省）：运行结束后输出最后一条助手文本；`json`：一个结果对象（文本、
 *   停止原因、用量、缓存命中率、[W3-C2] `cache` 统计（同 `get_session_stats.cache`）、全部条目）；
 *   `stream-json`：每个会话事件一行（线上形状同 RPC，含 `cache_miss` / `cache_warm` /
 *   `context_pressure`）。
 * - 重试：text / json 格式在 stderr 打一行 `↻ 重试 n/m`（stream-json 里本来就有事件），等待期间不再无声。
 * - 无人值守：ask → deny（bootstrap 已按 print 设 unattended）。被拒的调用（`tool_execution_end`
 *   带 `denied`）在 stderr 汇总一行（工具 ×次数、首个原因、放行办法），json 结果带 `deniedTools`。
 * - [W5-H2] 预算（`--max-turns N` / `--max-cost USD` / config `limits.*`，agent/limits.ts）：到限
 *   （会话发 `limit_reached`）→ stderr 一行、json 带 `limitReached{kind, value, limit}`（回合到限另带
 *   `maxTurnsReached: true`）、退出码 8。
 * - [W5-H2] plan 模式产出计划、`plan.unattended: stop`（缺省）没人审批：stderr 一行（计划文件与审批办法）、
 *   json 带 `planPending{planId, version, filePath}`、退出码 9。
 * - [W5-H2] `--image` / `@图片` 超限时按 config `images.resize` 缩放（缺省 auto）。
 * - 退出码：最终助手消息 `error / aborted` 或提示被拒 → 1；有工具调用被拒 → 7；到达预算 → 8；
 *   计划待审批 → 9；SIGINT 130、SIGTERM 143（先 abort）。
 */

import type { CliIo, ModeContext } from "../../cli/deps.js";
import { currentSession } from "../../cli/compose-session.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import { errorText, lastAssistant, onStdoutClosed, onTerminationSignals } from "../shared.js";
import { toJsonLine, toWireEvent } from "./json-event.js";
import { formatUsd } from "../../agent/limits.js";
import type { LimitReachedEvent, PlanProposedEvent, SessionEvent } from "../../agent/types.js";
import type { ImageBlock } from "../../ai/types.js";
import { promptImages, sessionModel } from "../image-input.js";

export function joinPrompt(argument: string | undefined, piped: string): string {
  const parts = [argument ?? "", piped.replace(/\s+$/, "")].filter((p) => p.trim() !== "");
  return parts.join("\n\n");
}

/** 等 stdin 多久后提示一次「正在等待」。 */
export const STDIN_WAIT_HINT_MS = 3_000;

/** 有提示参数时等管道首字节的缺省上限；`AMA_STDIN_WAIT_MS` 覆盖，0 = 不等待。 */
export const STDIN_FIRST_BYTE_MS = 2_000;

export function stdinWaitMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env["AMA_STDIN_WAIT_MS"];
  if (raw === undefined || raw.trim() === "") return STDIN_FIRST_BYTE_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : STDIN_FIRST_BYTE_MS;
}

/** io 没有首字节读取时的退化：整段读取与超时赛跑。 */
function readWithin(io: CliIo, ms: number): Promise<string | undefined> {
  if (io.readStdinFirstByte !== undefined) return io.readStdinFirstByte(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    io.readStdin().then(
      (text) => {
        clearTimeout(timer);
        resolve(text);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 决定读不读 stdin（规则见文件头）。`mode`：`auto` 按提示参数与 stdin 类型决定，`explicit`
 * （位置参数 `-`）一直等到 EOF，`off`（`--no-stdin`）不读。
 */
export async function readPromptStdin(
  io: CliIo,
  prompt: string | undefined,
  mode: "auto" | "explicit" | "off",
  hintMs = STDIN_WAIT_HINT_MS,
): Promise<string> {
  if (io.stdinIsTTY || mode === "off") return "";
  const kind = io.stdinKind?.() ?? "other";
  const safe = kind === "file" || kind === "null";
  if (prompt !== undefined && prompt !== "" && mode === "auto" && !safe) {
    const waitMs = stdinWaitMs(io.env);
    if (waitMs === 0) return "";
    const text = await readWithin(io, waitMs);
    if (text === undefined) {
      io.stderr(`ama: 未在 ${formatSeconds(waitMs)}内收到管道输入，已忽略；需要等待请在末尾加 -\n`);
      return "";
    }
    return text;
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

function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`;
}

export async function runPrintMode(runtime: Runtime, context: ModeContext): Promise<number> {
  const { io } = context;
  const format = context.args.outputFormat ?? "text";
  const stdinMode = context.args.noStdin ? "off" : context.args.stdin ? "explicit" : "auto";
  const piped = await readPromptStdin(io, context.prompt, stdinMode);
  const prompt = joinPrompt(context.prompt, piped);
  if (prompt === "") {
    io.stderr("ama: -p 需要提示（位置参数或 stdin 管道）\n");
    return ExitCode.Usage;
  }
  const session = currentSession(runtime);
  let images: ImageBlock[];
  const resize = runtime.config.images?.resize;
  try {
    images = await promptImages(
      prompt,
      context.args.images,
      io.cwd,
      sessionModel(runtime.providers, session),
      resize === undefined ? {} : { resize },
    );
  } catch (error) {
    io.stderr(`ama: ${errorText(error)}\n`);
    return ExitCode.Usage;
  }
  const denied: DeniedTool[] = [];
  let limit: LimitReachedEvent | undefined;
  let plan: PlanProposedEvent | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "limit_reached") limit ??= event;
    else if (event.type === "plan_proposed") plan = event;
    else if (event.type === "plan_resolved" && event.planId === plan?.planId) plan = undefined;
    if (event.type === "tool_execution_end" && event.denied === true)
      denied.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        reason: textOf(event),
      });
    if (format === "stream-json") io.stdout(`${toJsonLine(toWireEvent(event))}\n`);
    else if (event.type === "auto_retry_start")
      io.stderr(
        `ama: ↻ 重试 ${event.attempt}/${event.maxAttempts}（${Math.round(event.delayMs / 1000)}s 后）：${event.errorMessage}\n`,
      );
  });
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
        ...(denied.length > 0 ? { deniedTools: denied } : {}),
        ...(plan !== undefined
          ? {
              planPending: {
                planId: plan.planId,
                version: plan.version,
                ...(plan.filePath === undefined ? {} : { filePath: plan.filePath }),
              },
            }
          : {}),
        ...(limit !== undefined
          ? {
              limitReached: { kind: limit.kind, value: limit.value, limit: limit.limit },
              ...(limit.kind === "turns" ? { maxTurnsReached: true } : {}),
            }
          : {}),
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
  if (limit !== undefined) {
    if (denied.length > 0) io.stderr(`${describeDenied(denied)}\n`);
    io.stderr(`${describeLimit(limit)}\n`);
    return ExitCode.LimitReached;
  }
  if (last?.stopReason === "error" || last?.stopReason === "aborted") {
    io.stderr(`ama: ${last.errorMessage ?? "模型调用失败"}\n`);
    return ExitCode.RuntimeError;
  }
  if (denied.length > 0) io.stderr(`${describeDenied(denied)}\n`);
  if (plan !== undefined) {
    io.stderr(`${describePlanPending(plan)}\n`);
    return ExitCode.PlanPending;
  }
  if (denied.length > 0) return ExitCode.ToolDenied;
  return ExitCode.Ok;
}

/** stderr 一行：计划已落盘待审批（-p 不替人批准）。 */
export function describePlanPending(plan: PlanProposedEvent): string {
  const where = plan.filePath ?? plan.planId;
  return (
    `ama: 计划 v${plan.version} 已落盘、待审批（未执行）：${where}；-p 不替人批准——` +
    "在交互界面或 RPC plan_response 里审批，或设 plan.unattended: approve 让 -p 批准后接着执行"
  );
}

/** stderr 一行：哪个预算到限。 */
export function describeLimit(event: LimitReachedEvent): string {
  return event.kind === "turns"
    ? `ama: 已达到回合上限 ${event.limit}（--max-turns / limits.maxTurns），运行在完成前结束`
    : `ama: 已达到费用上限 ${formatUsd(event.limit)}（累计 ${formatUsd(event.value)}；` +
        "--max-cost / limits.maxCostUsd），运行在完成前结束";
}

/** 被拒的一次工具调用（json 结果的 `deniedTools` 元素）。 */
export interface DeniedTool {
  toolCallId: string;
  toolName: string;
  reason: string;
}

function textOf(event: Extract<SessionEvent, { type: "tool_execution_end" }>): string {
  const content = event.result.content;
  const text =
    typeof content === "string"
      ? content
      : content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return text.split("\n")[0]?.trim().slice(0, 200) ?? "";
}

/** stderr 一行：被拒的工具 ×次数、首个原因、放行办法。 */
export function describeDenied(denied: readonly DeniedTool[]): string {
  const counts = new Map<string, number>();
  for (const item of denied) counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + 1);
  const tools = [...counts].map(([name, n]) => `${name} ×${n}`).join("、");
  const reason = denied[0]?.reason ?? "";
  return (
    `ama: ${denied.length} 次工具调用被拒：${tools}${reason !== "" ? `（${reason}）` : ""}；` +
    "-p 没有人审批，需要放行时用 --permission-mode auto-edit|auto 或 --allow <规则>"
  );
}
