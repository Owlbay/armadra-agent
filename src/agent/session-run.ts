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
 */

import type { AssistantMessage, ImageBlock, UserMessage } from "../ai/types.js";
import { AmaError } from "../errors.js";
import type { AgentMessage } from "../session/types.js";
import type { RunOutcome } from "./loop.js";
import { classifyFailure, retryDelayMs, sleep } from "./retry.js";
import type { SessionCore } from "./session-core.js";
import type { CompactionController } from "./session-compaction.js";
import type { PromptDisposition, RetrySettings } from "./types.js";

export const MAX_STOP_HOOK_CONTINUATIONS = 3;
export const ABORTED_CUSTOM_TYPE = "ama.aborted";

export type RunDecision =
  | { kind: "done" }
  | { kind: "aborted" }
  | { kind: "retry"; errorMessage: string }
  | { kind: "overflow" }
  | { kind: "failed"; errorMessage: string };

export interface RunCycleDeps {
  core: SessionCore;
  compaction: CompactionController;
  retry(): RetrySettings;
  syncSystem(): void;
  stopRequested(): boolean;
  setRetrying(value: boolean): void;
  lastAssistantText(): string | null;
}

export function decideAfterRun(
  deps: RunCycleDeps,
  outcome: RunOutcome,
  retryAttempt: number,
  overflowRecovered: boolean,
): RunDecision {
  if (outcome.stopReason === "aborted") return { kind: "aborted" };
  const last = outcome.lastAssistant;
  if (last === undefined) return { kind: "done" };
  const failedStop = last.stopReason === "error" || outcome.stopReason === "length";
  if (!failedStop) return { kind: "done" };
  const errorMessage =
    last.errorMessage ?? (last.stopReason === "length" ? "output hit the token limit" : "error");
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
  if (kind === "retryable" && settings.enabled && retryAttempt < settings.maxRetries) {
    return { kind: "retry", errorMessage };
  }
  return { kind: "failed", errorMessage };
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
        decision = decideAfterRun(deps, result, retryAttempt, overflowRecovered);
        return decision.kind === "retry" || decision.kind === "overflow";
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
    endRetry(current.kind === "done", current.kind === "failed" ? current.errorMessage : undefined);

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
    } else if (current.kind === "failed") {
      warning = current.errorMessage;
      void core.runHook("Notification", {
        notification: { kind: "error", message: current.errorMessage },
      });
    }

    if (current.kind === "failed" && core.agent.followUpQueue.hasItems()) {
      next = core.agent.followUpQueue.drain();
      continue;
    }

    core.emit({ type: "agent_before_settle" });
    announced = true;
    if (
      current.kind === "done" &&
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

  if (!announced) core.emit({ type: "agent_before_settle" });
  const settled: Parameters<SessionCore["emit"]>[0] = { type: "agent_settled" };
  if (warning !== undefined) settled.warning = warning;
  core.emit(settled);
  void core.runHook("Notification", {
    notification: { kind: "settled", message: warning ?? "run finished" },
  });
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
  const prompts: AgentMessage[] = [makeUserMessage(prompt, images, origin)];
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
  core.emit({ type: "before_agent_start", prompt });
  await runCycle(deps, prompts, signal);
  return "started";
}
