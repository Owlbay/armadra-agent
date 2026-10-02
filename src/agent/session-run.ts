/**
 * 会话级 run 编排（设计 §3.6 重试、§4.2 abort、§6.1 Stop Hook、§9 溢出恢复）。[B2]
 *
 * 一次「会话周期」（prompt 到 agent_settled）可以包含多个 Agent run：
 * - 可重试错误：agent_end{willRetry:true} → 失败尝试 context_edit{reason:"retry"} 剔除 →
 *   auto_retry_start → 退避（abort 可打断）→ 新 run（continue）；结束时 auto_retry_end。
 * - 溢出 / length 无工具调用：agent_end{willRetry:true} → context_edit{reason:"overflow"} 剔除 →
 *   PreCompact → 压缩 → 以新 run 重试**一次**；失败 / 取消则保留剔除、不重试，agent_settled{warning}。
 * - abort：不清队列；落盘 custom_message{customType:"ama.aborted"}；不再自动续跑。
 * - 将要停下时发 agent_before_settle 并跑 Stop（子 Agent 为 SubagentStop）Hook：block + reason →
 *   以 reason 作为新 user 消息再跑一轮（上限 3 次，stopHookActive 传给 Hook）。
 * - 最终失败后若 followUp 队列非空，照常投递。
 * - [W5-H2] 模型回退：可重试错误在 overloaded 时、或重试用尽后，若配置了 `fallbackModel` 就切过去
 *   重试一次本请求（`model_fallback` 事件），回退模型回复后切回主模型；每个周期最多一次。
 * - [W5-H2] 扩展经 `noteSettleWarning` 登记的 warning（预算到限 `limit_reached`）写进本周期的 agent_settled；
 *   `limit_reached:` 开头的错误回复（预算拦下请求）不重试。
 * - [W5-H2] run 带 `warning`（重复调用检测 `repeated_tool_call`）：不跑 Stop Hook，agent_settled 带该 warning。
 */

import type { AssistantMessage, ImageBlock, UserMessage } from "../ai/types.js";
import { AmaError } from "../errors.js";
import type { AgentMessage } from "../session/types.js";
import type { RunOutcome } from "./loop.js";
import { formatModelRef, modelRefOf } from "../ai/providers/channels.js";
import { classifyFailure, retryDelayMs, sleep } from "./retry.js";
import type { SessionCore } from "./session-core.js";
import type { CompactionController } from "./session-compaction.js";
import type { PromptDisposition, RetrySettings } from "./types.js";

export const MAX_STOP_HOOK_CONTINUATIONS = 3;
export const ABORTED_CUSTOM_TYPE = "ama.aborted";
/** [W5-H2] 预算拦下请求时错误回复的前缀（limits.ts）：判为最终失败，不重试、不回退。 */
export const LIMIT_ERROR_PREFIX = "limit_reached:";

/** [W5-H2] 扩展（limits）登记的 agent_settled warning：本周期收尾时取走。 */
const settleWarnings = new WeakMap<SessionCore, string>();

export function noteSettleWarning(core: SessionCore, warning: string): void {
  if (!settleWarnings.has(core)) settleWarnings.set(core, warning);
}

function takeSettleWarning(core: SessionCore): string | undefined {
  const warning = settleWarnings.get(core);
  settleWarnings.delete(core);
  return warning;
}

export type RunDecision =
  | { kind: "done" }
  | { kind: "aborted" }
  | { kind: "retry"; errorMessage: string }
  | { kind: "overflow" }
  | { kind: "failed"; errorMessage: string }
  /** [W5-H2] 切到 `fallbackModel` 重试一次本请求（overloaded，或可重试错误的重试已用尽）。 */
  | { kind: "fallback"; errorMessage: string };

export interface RunCycleDeps {
  core: SessionCore;
  compaction: CompactionController;
  retry(): RetrySettings;
  syncSystem(): void;
  stopRequested(): boolean;
  setRetrying(value: boolean): void;
  lastAssistantText(): string | null;
  /** [RW-B] 开启新回合的用户消息已构造、尚未落盘（建检查点、追加回滚提示）。 */
  beginTurn?(message: UserMessage): void;
  /** [W5-C0] 扩展点 beforePrompts：返回追加在 prompts 之后的消息（session-extensions.ts）。 */
  beforePrompts?(prompts: readonly AgentMessage[]): Promise<AgentMessage[]>;
  /** [W5-C0] 扩展点 onAgentSettled：agent_settled 之后、周期结束之前。 */
  afterSettled?(): Promise<void>;
}

export function decideAfterRun(
  deps: RunCycleDeps,
  outcome: RunOutcome,
  retryAttempt: number,
  overflowRecovered: boolean,
  fallbackUsed = false,
): RunDecision {
  if (outcome.stopReason === "aborted") return { kind: "aborted" };
  const last = outcome.lastAssistant;
  if (last === undefined) return { kind: "done" };
  const failedStop = last.stopReason === "error" || outcome.stopReason === "length";
  if (!failedStop) return { kind: "done" };
  const errorMessage =
    last.errorMessage ?? (last.stopReason === "length" ? "output hit the token limit" : "error");
  if (errorMessage.startsWith(LIMIT_ERROR_PREFIX)) return { kind: "failed", errorMessage };
  const classifyOptions =
    deps.core.options.isContextOverflow === undefined
      ? {}
      : { isContextOverflow: deps.core.options.isContextOverflow };
  const kind = classifyFailure(last, classifyOptions);
  if (kind === "overflow") {
    const compaction = deps.compaction;
    const recoverable =
      !overflowRecovered &&
      compaction.settings.enabled &&
      deps.core.model().contextWindow !== undefined &&
      !compaction.breaker.tripped;
    return recoverable ? { kind: "overflow" } : { kind: "failed", errorMessage };
  }
  const settings = deps.retry();
  const canFallback =
    kind === "retryable" && !fallbackUsed && fallbackTarget(deps.core) !== undefined;
  if (canFallback && OVERLOADED.test(errorMessage)) return { kind: "fallback", errorMessage };
  if (kind === "retryable" && settings.enabled && retryAttempt < settings.maxRetries) {
    return { kind: "retry", errorMessage };
  }
  if (canFallback) return { kind: "fallback", errorMessage };
  return { kind: "failed", errorMessage };
}

const OVERLOADED = /overloaded/i;

/** 能切换模型的会话（AgentSessionImpl 的公开 `setModel`；SessionCore 不含它）。 */
type ModelSwitcher = SessionCore & { setModel?(ref: string): Promise<void> };

/** 配置了与当前模型不同、且能找到的回退模型时返回它的引用。 */
function fallbackTarget(core: SessionCore): string | undefined {
  const target = core.options.fallbackModel?.trim();
  if (target === undefined || target === "") return undefined;
  if ((core as ModelSwitcher).setModel === undefined) return undefined;
  const current = core.model();
  const refs = [formatModelRef(current), `${current.provider}/${current.id}`];
  if (refs.includes(target)) return undefined;
  // 找不到的回退模型等于没配：照常重试（启动时不校验，避免目录未加载时误报）
  return core.options.providers.findModel(target).ok ? target : undefined;
}

/**
 * [W5-H2] 模型回退（§8.3 H7）：经 `setModel` 切到回退模型（落 model_change、发 model_changed——缓存
 * 未命中归因 `model_changed`，思考块按跨模型规则降级），发 `model_fallback{from, to, reason}`；
 * 回退模型的第一条回复落盘后切回主模型（下一次请求仍用主模型）。返回「切回」函数；切换失败返回
 * undefined（按最终失败处理）。
 */
async function switchToFallback(
  core: SessionCore,
  reason: string,
): Promise<(() => Promise<void>) | undefined> {
  const target = fallbackTarget(core);
  const switcher = core as ModelSwitcher;
  if (target === undefined || switcher.setModel === undefined) return undefined;
  const primary = core.model();
  try {
    await switcher.setModel(target);
  } catch (error) {
    core.log("warn", `fallbackModel ${target} unavailable: ${String(error)}`);
    return undefined;
  }
  core.emit({
    type: "model_fallback",
    from: modelRefOf(primary),
    to: modelRefOf(core.model()),
    reason,
  });
  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    unsubscribe();
    try {
      await switcher.setModel?.(formatModelRef(primary));
    } catch (error) {
      core.log("warn", `cannot switch back to ${formatModelRef(primary)}: ${String(error)}`);
    }
  };
  const unsubscribe = core.agent.subscribe(async (event) => {
    if (event.type === "message_end" && event.message.role === "assistant") await restore();
  });
  return restore;
}

/** 用 context_edit 把失败尝试（助手消息与其后补的结果）从上下文剔除。 */
export function excludeFailedAttempt(
  core: SessionCore,
  failed: AssistantMessage | undefined,
  reason: "retry" | "overflow",
): void {
  if (failed === undefined) return;
  const branch = core.manager.branch();
  const at = branch.findIndex((entry) => entry.type === "message" && entry.message === failed);
  if (at < 0) return;
  const targets = [branch[at]?.id];
  for (const entry of branch.slice(at + 1)) {
    if (entry.type === "message" && entry.message.role === "toolResult") targets.push(entry.id);
  }
  for (const targetId of targets) {
    if (targetId !== undefined) {
      core.appendEntry({ type: "context_edit", targetId, replacement: null, reason });
    }
  }
  core.reloadMessages();
}

export function recordAbort(core: SessionCore): void {
  core.appendEntry({
    type: "custom_message",
    customType: ABORTED_CUSTOM_TYPE,
    content: "The user interrupted the previous response before it finished.",
    display: false,
  });
  core.reloadMessages();
}

export async function runCycle(
  deps: RunCycleDeps,
  prompts: AgentMessage[],
  signal: AbortSignal,
): Promise<void> {
  const { core, compaction } = deps;
  let next: AgentMessage[] | undefined = prompts;
  let retryAttempt = 0;
  let overflowRecovered = false;
  let stopHooks = 0;
  let warning: string | undefined;
  let announced = false;
  let fallbackUsed = false;
  let restoreModel: (() => Promise<void>) | undefined;

  const endRetry = (success: boolean, finalError?: string): void => {
    if (retryAttempt === 0) return;
    const event: Parameters<SessionCore["emit"]>[0] = {
      type: "auto_retry_end",
      success,
      attempt: retryAttempt,
    };
    if (finalError !== undefined) event.finalError = finalError;
    core.emit(event);
    deps.setRetrying(false);
    retryAttempt = 0;
  };

  while (next !== undefined) {
    announced = false;
    let decision: RunDecision = { kind: "done" };
    const outcome = await core.agent.run(next, {
      signal,
      onRunEnd: (result) => {
        decision = decideAfterRun(deps, result, retryAttempt, overflowRecovered, fallbackUsed);
        return (
          decision.kind === "retry" || decision.kind === "overflow" || decision.kind === "fallback"
        );
      },
    });
    next = undefined;
    const current = decision as RunDecision;

    if (current.kind === "aborted" || signal.aborted) {
      endRetry(false, "aborted");
      recordAbort(core);
      break;
    }
    if (current.kind === "retry") {
      retryAttempt++;
      deps.setRetrying(true);
      excludeFailedAttempt(core, outcome.lastAssistant, "retry");
      const settings = deps.retry();
      const delayMs = retryDelayMs(retryAttempt, settings);
      core.emit({
        type: "auto_retry_start",
        attempt: retryAttempt,
        maxAttempts: settings.maxRetries,
        delayMs,
        errorMessage: current.errorMessage,
      });
      void core.runHook("Notification", {
        notification: {
          kind: "retry",
          message: `retry ${retryAttempt}/${settings.maxRetries}: ${current.errorMessage}`,
        },
      });
      try {
        await sleep(delayMs, signal);
      } catch {
        endRetry(false, "aborted");
        recordAbort(core);
        break;
      }
      next = [];
      continue;
    }
    if (current.kind === "fallback") {
      fallbackUsed = true;
      endRetry(false, current.errorMessage);
      restoreModel = await switchToFallback(core, current.errorMessage);
      if (restoreModel !== undefined) {
        excludeFailedAttempt(core, outcome.lastAssistant, "retry");
        next = [];
        continue;
      }
    }
    endRetry(current.kind === "done", current.kind === "failed" ? current.errorMessage : undefined);
    // [W5-H2] harness 提前结束（重复调用检测）：带 warning 停下，不跑 Stop Hook、不续投队列
    const harnessStop = outcome.warning;
    if (harnessStop !== undefined) warning = harnessStop;

    if (current.kind === "overflow") {
      overflowRecovered = true;
      excludeFailedAttempt(core, outcome.lastAssistant, "overflow");
      const recovery = await compaction.recoverOverflow(signal);
      if (signal.aborted) {
        recordAbort(core);
        break;
      }
      if (recovery.retry) {
        next = [];
        continue;
      }
      warning = recovery.warning;
    } else if (current.kind === "failed" || current.kind === "fallback") {
      warning = current.errorMessage;
      void core.runHook("Notification", {
        notification: { kind: "error", message: current.errorMessage },
      });
    }

    if (
      (current.kind === "failed" || current.kind === "fallback") &&
      core.agent.followUpQueue.hasItems()
    ) {
      next = core.agent.followUpQueue.drain();
      continue;
    }

    core.emit({ type: "agent_before_settle" });
    announced = true;
    if (
      current.kind === "done" &&
      harnessStop === undefined &&
      !deps.stopRequested() &&
      stopHooks < MAX_STOP_HOOK_CONTINUATIONS
    ) {
      const event = core.depth > 0 ? "SubagentStop" : "Stop";
      const lastText = deps.lastAssistantText();
      const payload =
        lastText === null
          ? { stopHookActive: stopHooks > 0 }
          : { lastAssistantText: lastText, stopHookActive: stopHooks > 0 };
      const hook = await core.runHook(event, payload, signal);
      if (hook !== undefined && hook.decision === "block" && !hook.stop && !signal.aborted) {
        stopHooks++;
        next = [makeUserMessage(hook.reason ?? "Continue.", undefined, "hook")];
        continue;
      }
    }
  }

  await restoreModel?.();
  if (!announced) core.emit({ type: "agent_before_settle" });
  const settled: Parameters<SessionCore["emit"]>[0] = { type: "agent_settled" };
  const noted = takeSettleWarning(core);
  if (noted !== undefined && (warning === undefined || warning.startsWith(LIMIT_ERROR_PREFIX)))
    warning = noted;
  if (warning !== undefined) settled.warning = warning;
  core.emit(settled);
  void core.runHook("Notification", {
    notification: { kind: "settled", message: warning ?? "run finished" },
  });
  await deps.afterSettled?.();
}

/** `"user"` = 普通用户输入，不写 origin。 */
export function normalizeOrigin(origin: string | undefined): string | undefined {
  return origin === undefined || origin === "user" ? undefined : origin;
}

export function makeUserMessage(
  text: string,
  images?: readonly ImageBlock[],
  origin?: string,
): UserMessage {
  const message: UserMessage = {
    role: "user",
    content: images !== undefined && images.length > 0 ? [{ type: "text", text }, ...images] : text,
    timestamp: Date.now(),
  };
  if (origin !== undefined) message.origin = origin;
  return message;
}

/**
 * 一次提示：展开（expandPrompt）→ UserPromptSubmit Hook（block 拒绝；updatedPrompt 替换；
 * additionalContext 作为 custom_message 随提示进上下文）→ 阈值压缩检查 → system 同步 →
 * `before_agent_start`（宿主事件同名，由组装根桥接）→ 会话周期。
 */
export async function runPrompt(
  deps: RunCycleDeps,
  text: string,
  images: readonly ImageBlock[] | undefined,
  origin: string | undefined,
  signal: AbortSignal,
): Promise<PromptDisposition> {
  const { core } = deps;
  let prompt = text;
  if (core.options.expandPrompt !== undefined) {
    const expanded = await core.options.expandPrompt(text);
    if ("handled" in expanded) return "handled";
    prompt = expanded.text;
  }
  const hook = await core.runHook("UserPromptSubmit", { prompt }, signal);
  if (hook !== undefined) {
    if (hook.decision === "block" || hook.decision === "deny" || hook.stop) {
      throw new AmaError(
        "prompt_blocked",
        hook.reason ?? "prompt blocked by UserPromptSubmit hook",
      );
    }
    if (hook.updatedPrompt !== undefined) prompt = hook.updatedPrompt;
  }
  const message = makeUserMessage(prompt, images, origin);
  const prompts: AgentMessage[] = [message];
  if (hook?.additionalContext !== undefined && hook.additionalContext !== "") {
    prompts.push({
      role: "custom",
      customType: "ama.hook_context",
      content: hook.additionalContext,
      display: false,
      timestamp: Date.now(),
    });
  }
  await deps.compaction.checkThreshold(signal);
  if (signal.aborted) return "handled";
  deps.syncSystem();
  deps.beginTurn?.(message);
  if (deps.beforePrompts !== undefined) prompts.push(...(await deps.beforePrompts(prompts)));
  core.emit({ type: "before_agent_start", prompt });
  await runCycle(deps, prompts, signal);
  return "started";
}
