/**
 * runLoop 状态机（设计 §4.1）。[B2]
 *
 * ```text
 * turn_start → 投递 prompts / steer → beforeRequest（system 补丁、首次落盘）→ 流式请求
 *   ├─ error / aborted：补齐悬空 tool_call 的结果 → finishTurn → turn_end → 返回
 *   ├─ length 且有 tool_call：整批判失败
 *   └─ 有 tool_call：tool-runner 执行，结果按原序入转录
 * finishTurn → turn_end → abort? → 收 steer（投递点 = 本轮工具全部结束、下一次模型调用前）
 * 内层结束（无 tool_call 且 steer 空）→ 收 followUp（有则继续外层）→ 返回
 * ```
 *
 * 循环不发 agent_start / agent_end（由 Agent 发，以便带上 willRetry）；上下文每次请求前从
 * `getMessages()` 现取（压缩 / context_edit 会替换 Agent 的消息数组）。
 */

import type {
  AssistantMessage,
  Model,
  ModelThinkingLevel,
  StreamOptions,
  Usage,
} from "../ai/types.js";
import type { StreamFn } from "../compaction/summarize-tier.js";
import type { AgentMessage } from "../session/types.js";
import {
  closeDanglingCalls,
  failTruncatedBatch,
  runToolBatch,
  toolCallsOf,
  type LoopEmit,
  type ToolRunnerOptions,
} from "./tool-runner.js";
import type { LoopHooks, PreparedRequest, TurnResult } from "./types.js";

export type { StreamFn } from "../compaction/summarize-tier.js";

export type LoopCallbacks = Omit<LoopHooks, "getSteeringMessages" | "getFollowUpMessages">;

export interface LoopConfig {
  hooks: LoopCallbacks;
  getSteeringMessages(): AgentMessage[];
  getFollowUpMessages(): AgentMessage[];
  getMessages(): readonly AgentMessage[];
  getModel(): Model;
  getThinkingLevel(): ModelThinkingLevel;
  stream: StreamFn;
  /** 每次请求的额外选项（apiKey、sessionId 等）；signal / thinkingLevel 由循环填。 */
  streamOptions?(model: Model): Promise<Partial<StreamOptions>> | Partial<StreamOptions>;
  /** 每次模型请求前：system 补丁、首次落盘、阈值检查等。 */
  beforeRequest?(signal: AbortSignal): Promise<void>;
  tools: ToolRunnerOptions;
  emit: LoopEmit;
}

export interface RunOutcome {
  /** 最后一条助手消息（本 run 未产生则 undefined）。 */
  lastAssistant: AssistantMessage | undefined;
  /** 最后一条助手消息的 stopReason；工具执行中被中断为 "aborted"。 */
  stopReason: string;
  newMessages: AgentMessage[];
}

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};

export function failureMessage(
  model: Model,
  stopReason: "error" | "aborted",
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...ZERO_USAGE },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

async function streamAssistant(
  request: PreparedRequest,
  config: LoopConfig,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  const { model, thinkingLevel } = request;
  const emit = config.emit;
  let started = false;
  const finish = async (message: AssistantMessage): Promise<AssistantMessage> => {
    const final: AssistantMessage =
      message.thinkingLevel === undefined ? { ...message, thinkingLevel } : message;
    if (!started) await emit({ type: "message_start", message: final });
    await emit({ type: "message_end", message: final });
    return final;
  };
  try {
    const extra = (await config.streamOptions?.(model)) ?? {};
    const options: StreamOptions = { ...extra, signal, thinkingLevel };
    const stream = config.stream(model, request.context, options);
    for await (const event of stream) {
      switch (event.type) {
        case "start":
          started = true;
          await emit({ type: "message_start", message: { ...event.partial } });
          break;
        case "done":
        case "error":
          return finish(await stream.result());
        default:
          if (started) {
            await emit({
              type: "message_update",
              message: { ...event.partial },
              assistantMessageEvent: event,
            });
          }
      }
    }
    return finish(await stream.result());
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return finish(failureMessage(model, signal.aborted ? "aborted" : "error", text));
  }
}

async function deliver(
  messages: readonly AgentMessage[],
  emit: LoopEmit,
  out: AgentMessage[],
): Promise<void> {
  for (const message of messages) {
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
    out.push(message);
  }
}

export interface RunLoopOptions {
  /** continue 场景：开头不收 steer（调用方已把 steer 作为 prompts 传入）。 */
  skipInitialSteering?: boolean;
}

export async function runLoop(
  prompts: readonly AgentMessage[],
  config: LoopConfig,
  signal: AbortSignal,
  options: RunLoopOptions = {},
): Promise<RunOutcome> {
  const { hooks, emit } = config;
  const newMessages: AgentMessage[] = [];
  let lastAssistant: AssistantMessage | undefined;
  let lastTurn: TurnResult | undefined;
  const outcome = (stopReason: string): RunOutcome => ({ lastAssistant, stopReason, newMessages });

  await emit({ type: "turn_start" });
  await deliver(prompts, emit, newMessages);
  let pending = options.skipInitialSteering === true ? [] : config.getSteeringMessages();

  for (;;) {
    let hasMoreToolCalls = true;
    while (hasMoreToolCalls || pending.length > 0) {
      if (lastTurn !== undefined) {
        await hooks.prepareNextTurn?.(lastTurn);
        if (pending.length === 0) pending = config.getSteeringMessages();
        await emit({ type: "turn_start" });
      }
      await deliver(pending, emit, newMessages);
      pending = [];

      await config.beforeRequest?.(signal);
      if (signal.aborted) return outcome("aborted");

      let messages = [...config.getMessages()];
      if (hooks.transformContext !== undefined)
        messages = await hooks.transformContext(messages, signal);
      let request: PreparedRequest = {
        context: { messages: hooks.convertToLlm(messages) },
        model: config.getModel(),
        thinkingLevel: config.getThinkingLevel(),
      };
      if (hooks.prepareRequest !== undefined) request = await hooks.prepareRequest(request);

      const assistant = await streamAssistant(request, config, signal);
      lastAssistant = assistant;
      newMessages.push(assistant);

      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        const closed = await closeDanglingCalls(assistant, emit);
        newMessages.push(...closed);
        lastTurn = { assistant, toolResults: closed };
        await hooks.finishTurn?.(lastTurn);
        await emit({ type: "turn_end", message: assistant, toolResults: closed });
        return outcome(assistant.stopReason);
      }

      const calls = toolCallsOf(assistant);
      hasMoreToolCalls = false;
      let toolResults: TurnResult["toolResults"] = [];
      if (calls.length > 0) {
        const batch =
          assistant.stopReason === "length"
            ? await failTruncatedBatch(assistant, emit)
            : await runToolBatch(assistant, config.tools, signal, emit);
        toolResults = batch.messages;
        newMessages.push(...toolResults);
        hasMoreToolCalls = !batch.terminate;
      }
      lastTurn = { assistant, toolResults };
      const decision = await hooks.finishTurn?.(lastTurn);
      await emit({ type: "turn_end", message: assistant, toolResults });
      if (signal.aborted) return outcome("aborted");
      // length 且无工具调用：输出被截断，交给会话层的溢出恢复，不投递 steer / followUp。
      if (assistant.stopReason === "length" && calls.length === 0) return outcome("length");
      if (decision === "end") return outcome(assistant.stopReason);
      pending = config.getSteeringMessages();
    }
    const followUps = config.getFollowUpMessages();
    if (followUps.length === 0) break;
    pending = followUps;
  }
  return outcome(lastAssistant?.stopReason ?? "stop");
}
