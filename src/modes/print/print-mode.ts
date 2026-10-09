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
 *   带 `denied`）在 stderr 汇总一行（工具 ×次数、首个原因、放行办法），json 结果带 `deniedTools`；
 *   [S-A] minimal / coordinator 下被拒的 bash 形如 grep / rg / find 时再补一行怎么加回 grep / glob。
 * - [W5-H2] 预算（`--max-turns N` / `--max-cost USD` / config `limits.*`，agent/limits.ts）：到限
 *   （会话发 `limit_reached`）→ stderr 一行、json 带 `limitReached{kind, value, limit}`（回合到限另带
 *   `maxTurnsReached: true`）、退出码 8。
 * - [W5-H2] plan 模式产出计划、`plan.unattended: stop`（缺省）没人审批：stderr 一行（计划文件与审批办法）、
 *   json 带 `planPending{planId, version, filePath}`、退出码 9。
 * - [W5-H2] `--image` / `@图片` 超限时按 config `images.resize` 缩放（缺省 auto）。
 * - [W7-B2] 后台子 Agent（显式 `background:true` 或 `subagents.background: always`）：主回合结束后若还有任务
 *   在跑或通知待投递，stderr 一行提示并等它们结束、跑完通知回合再输出（最终文本 = 最后一条助手回复）；
 *   受 `--max-turns` / `--max-cost` / `limits.*` 约束（到限即停止等待，退出码 8），SIGINT / SIGTERM 照常中止
 *   （未结束的任务随会话关闭被停止）；json 结果带 `tasks`（同 `getStats().tasks`）。
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
import type { AgentSession, SessionStats } from "../../agent/types.js";
import { registryOf } from "../../agent/subagent-registry.js";
import { promptImages, sessionModel } from "../image-input.js";
import { msg } from "../../i18n/index.js";
import { searchToolsHint } from "./search-hint.js";

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
      io.stderr(msg().print.print.stdinIgnored(formatSeconds(waitMs)));
      return "";
    }
    return text;
  }
  const timer = safe
    ? undefined
    : setTimeout(() => io.stderr(msg().print.print.stdinWaiting), hintMs);
  try {
    return await io.readStdin();
  } finally {
    clearTimeout(timer);
  }
}

function formatSeconds(ms: number): string {
  const m = msg().print.print;
  return ms % 1000 === 0 ? m.seconds(ms / 1000) : m.millis(ms);
}

export async function runPrintMode(runtime: Runtime, context: ModeContext): Promise<number> {
  const { io } = context;
  const format = context.args.outputFormat ?? "text";
  const stdinMode = context.args.noStdin ? "off" : context.args.stdin ? "explicit" : "auto";
  const piped = await readPromptStdin(io, context.prompt, stdinMode);
  const prompt = joinPrompt(context.prompt, piped);
  if (prompt === "") {
    io.stderr(msg().print.print.needsPrompt);
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
  const bashCommands = new Map<string, string>();
  const deniedBash: string[] = [];
  let limit: LimitReachedEvent | undefined;
  let plan: PlanProposedEvent | undefined;
  let stopWaiting: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stopWaiting = resolve;
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "limit_reached") {
      limit ??= event;
      stopWaiting();
    } else if (event.type === "plan_proposed") plan = event;
    else if (event.type === "plan_resolved" && event.planId === plan?.planId) plan = undefined;
    if (event.type === "tool_execution_start" && event.toolName === "bash") {
      const command = (event.args as { command?: unknown } | undefined)?.command;
      if (typeof command === "string") bashCommands.set(event.toolCallId, command);
    }
    if (event.type === "tool_execution_end" && event.denied === true) {
      denied.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        reason: textOf(event),
      });
      const command = bashCommands.get(event.toolCallId);
      if (event.toolName === "bash" && command !== undefined) deniedBash.push(command);
    }
    if (format === "stream-json") io.stdout(`${toJsonLine(toWireEvent(event))}\n`);
    else if (event.type === "auto_retry_start")
      io.stderr(
        msg().print.print.retry(
          event.attempt,
          event.maxAttempts,
          Math.round(event.delayMs / 1000),
          event.errorMessage,
        ),
      );
  });
  let signalled: number | undefined;
  const offSignals = onTerminationSignals((code) => {
    signalled ??= code;
    stopWaiting();
    void session.abort();
  });
  let stdoutClosed = false;
  const offEpipe = onStdoutClosed(() => {
    stdoutClosed = true;
    stopWaiting();
    void session.abort();
  });
  let failure: string | undefined;
  try {
    await session.prompt(prompt, images.length > 0 ? { images } : {});
    const ended = lastAssistant(session)?.stopReason;
    if (
      signalled === undefined &&
      !stdoutClosed &&
      limit === undefined &&
      ended !== "error" &&
      ended !== "aborted"
    )
      await waitBackgroundTasks(session, stopped, io);
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
        ...contextOf(stats),
        ...(stats.cache !== undefined ? { cache: stats.cache } : {}),
        ...(stats.tasks !== undefined ? { tasks: stats.tasks } : {}),
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
  const deniedText = (): string => {
    const hint = searchToolsHint(
      deniedBash,
      runtime.config.tools?.preset ?? "default",
      runtime.tools.active().map((tool) => tool.name),
    );
    return `${describeDenied(denied)}\n${hint === undefined ? "" : `${hint}\n`}`;
  };
  if (signalled !== undefined) return signalled;
  if (stdoutClosed) return ExitCode.Ok; // 下游（如 `| head`）已拿够输出
  if (failure !== undefined) {
    io.stderr(`ama: ${failure}\n`);
    return ExitCode.RuntimeError;
  }
  if (limit !== undefined) {
    if (denied.length > 0) io.stderr(deniedText());
    io.stderr(`${describeLimit(limit)}\n`);
    return ExitCode.LimitReached;
  }
  if (last?.stopReason === "error" || last?.stopReason === "aborted") {
    io.stderr(`ama: ${last.errorMessage ?? msg().print.print.modelFailed}\n`);
    return ExitCode.RuntimeError;
  }
  if (denied.length > 0) io.stderr(deniedText());
  if (plan !== undefined) {
    io.stderr(`${describePlanPending(plan)}\n`);
    return ExitCode.PlanPending;
  }
  if (denied.length > 0) return ExitCode.ToolDenied;
  return ExitCode.Ok;
}

/**
 * [W7-B2] 主回合结束后等后台任务与它们的通知回合（docs/agents-concurrency-plan.md §2.6、§6 Q5）。
 * `settled()`（subagent-background.ts）等到没有运行中任务且通知投递链（含通知回合）结束；`stopped`：SIGINT /
 * SIGTERM、stdout 关闭或预算到限时 resolve，立即停止等待。没有子 Agent 注册表时直接返回。
 */
export async function waitBackgroundTasks(
  session: AgentSession,
  stopped: Promise<void>,
  io: Pick<CliIo, "stderr">,
): Promise<void> {
  const registry = registryOf(session.state.sessionId);
  if (registry === undefined) return;
  const running = registry.list().filter((task) => task.status === "running").length;
  if (running > 0) io.stderr(msg().print.print.waitingTasks(running));
  await Promise.race([registry.settled(), stopped]);
}

/** stderr 一行：计划已落盘待审批（-p 不替人批准）。 */
export function describePlanPending(plan: PlanProposedEvent): string {
  const where = plan.filePath ?? plan.planId;
  return msg().print.print.planPending(plan.version, where);
}

/** stderr 一行：哪个预算到限。 */
export function describeLimit(event: LimitReachedEvent): string {
  const m = msg().print.print;
  return event.kind === "turns"
    ? m.limitTurns(event.limit)
    : m.limitCost(formatUsd(event.limit), formatUsd(event.value));
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
  const tools = [...counts].map(([name, n]) => `${name} ×${n}`);
  return msg().print.print.denied(denied.length, tools, denied[0]?.reason ?? "");
}

/** json 结果的 `context`：上下文用量、窗口与占用（0–100）；各项未知时省略，全都未知时不带 `context`。 */
function contextOf(stats: SessionStats): { context?: Record<string, number> } {
  const context: Record<string, number> = {};
  if (stats.contextTokens !== undefined) context["tokens"] = stats.contextTokens;
  if (stats.contextWindow !== undefined) context["window"] = stats.contextWindow;
  if (stats.contextPercent !== undefined) context["percent"] = stats.contextPercent;
  return Object.keys(context).length > 0 ? { context } : {};
}
