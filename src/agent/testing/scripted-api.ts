/**
 * 脚本化流桩（B2 测试用；B1 的 fake 供应商就绪前的最小替身）。[B2]
 *
 * 实现 `ApiImplementation` 契约：按第 n 次调用取脚本步骤，产出符合流契约的事件序列
 * （先 `start`、块事件配对、恰好一个终止事件、取消 → `error{reason:"aborted"}`、不抛错）。
 * usage 缺省按收到的上下文估算（字符 / 4），用来驱动压缩阈值。
 */

import type {
  Api,
  ApiImplementation,
  AssistantEvent,
  AssistantEventStream,
  AssistantMessage,
  Message,
  Model,
  StreamOptions,
  ToolCallBlock,
  TranscriptContext,
  Usage,
} from "../../ai/types.js";

export interface ScriptToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export type ScriptStep =
  | {
      kind?: "reply";
      text?: string;
      thinking?: string;
      toolCalls?: ScriptToolCall[];
      stopReason?: "stop" | "length" | "toolUse";
      usage?: Partial<Usage>;
    }
  | { kind: "error"; message: string; partialText?: string }
  /** 发完 start（与可选文本）后挂起，直到 abort。 */
  | { kind: "hang"; text?: string; toolCalls?: ScriptToolCall[] };

export interface ScriptCall {
  index: number;
  model: Model;
  context: TranscriptContext;
  options: StreamOptions;
}

export type ScriptSource = ScriptStep[] | ((call: ScriptCall) => ScriptStep);

export interface ScriptedApi {
  readonly api: ApiImplementation;
  readonly calls: ScriptCall[];
}

export interface ScriptedApiOptions {
  id?: Api;
  /** 每个事件之间的延迟（毫秒）；0 = 只让出微任务。 */
  delayMs?: number;
  /** 脚本用完时的步骤（缺省：文本 "done"）。 */
  fallback?: ScriptStep;
}

function contextChars(messages: readonly Message[]): number {
  let chars = 0;
  for (const message of messages) {
    if (message.role === "system") {
      for (const text of Object.values(message.sections)) chars += text?.length ?? 0;
      if (message.toolsAdded) chars += JSON.stringify(message.toolsAdded).length;
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else chars += block.name.length + JSON.stringify(block.arguments).length;
      }
    } else if (typeof message.content === "string") chars += message.content.length;
    else
      for (const block of message.content)
        chars += block.type === "text" ? block.text.length : 6400;
  }
  return chars;
}

class QueueStream implements AssistantEventStream {
  private readonly events: AssistantEvent[] = [];
  private waiting: (() => void) | undefined;
  private ended = false;
  private resolveFinal: (message: AssistantMessage) => void = () => {};
  private readonly final = new Promise<AssistantMessage>((resolve) => {
    this.resolveFinal = resolve;
  });

  push(event: AssistantEvent): void {
    this.events.push(event);
    if (event.type === "done" || event.type === "error") {
      this.ended = true;
      this.resolveFinal(event.type === "done" ? event.message : event.message);
    }
    this.waiting?.();
  }

  result(): Promise<AssistantMessage> {
    return this.final;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantEvent> {
    for (;;) {
      const next = this.events.shift();
      if (next !== undefined) {
        yield next;
        if (next.type === "done" || next.type === "error") return;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = undefined;
    }
  }
}

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

let callCounter = 0;

export function createScriptedApi(
  source: ScriptSource,
  options: ScriptedApiOptions = {},
): ScriptedApi {
  const calls: ScriptCall[] = [];
  const id = options.id ?? "fake";
  const fallback: ScriptStep = options.fallback ?? { text: "done" };

  const stream = (
    model: Model,
    context: TranscriptContext,
    streamOptions: StreamOptions,
  ): AssistantEventStream => {
    const call: ScriptCall = { index: calls.length, model, context, options: streamOptions };
    calls.push(call);
    const step = Array.isArray(source) ? (source[call.index] ?? fallback) : source(call);
    const out = new QueueStream();
    const inputTokens = Math.ceil(contextChars(context.messages) / 4);
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: id,
      provider: model.provider,
      model: model.id,
      usage: {
        input: inputTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: inputTokens,
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const snapshot = (): AssistantMessage => structuredClone(partial);
    const signal = streamOptions.signal;
    const aborted = (): boolean => signal.aborted;
    const finishAborted = (): void => {
      partial.stopReason = "aborted";
      partial.errorMessage = "aborted";
      out.push({ type: "error", reason: "aborted", message: snapshot() });
    };

    void (async () => {
      const delay = options.delayMs ?? 0;
      await pause(delay);
      if (aborted()) return finishAborted();
      if (step.kind === "error" && step.partialText === undefined) {
        partial.stopReason = "error";
        partial.errorMessage = step.message;
        out.push({ type: "error", reason: "error", message: snapshot() });
        return;
      }
      out.push({ type: "start", partial: snapshot() });
      const addText = async (text: string): Promise<void> => {
        const index = partial.content.length;
        partial.content.push({ type: "text", text: "" });
        out.push({ type: "text_start", contentIndex: index, partial: snapshot() });
        const block = partial.content[index];
        if (block?.type === "text") block.text = text;
        out.push({ type: "text_delta", contentIndex: index, delta: text, partial: snapshot() });
        await pause(delay);
        out.push({ type: "text_end", contentIndex: index, partial: snapshot() });
      };
      const addCalls = async (calls: ScriptToolCall[]): Promise<void> => {
        for (const [n, spec] of calls.entries()) {
          const index = partial.content.length;
          const callId = spec.id ?? `call_${++callCounter}_${n}`;
          const block: ToolCallBlock = {
            type: "toolCall",
            id: callId,
            name: spec.name,
            arguments: {},
          };
          partial.content.push(block);
          out.push({
            type: "toolcall_start",
            contentIndex: index,
            id: callId,
            name: spec.name,
            partial: snapshot(),
          });
          const json = JSON.stringify(spec.args);
          out.push({
            type: "toolcall_delta",
            contentIndex: index,
            delta: json,
            partial: snapshot(),
          });
          block.arguments = structuredClone(spec.args);
          out.push({
            type: "toolcall_end",
            contentIndex: index,
            toolCall: structuredClone(block),
            partial: snapshot(),
          });
          await pause(delay);
        }
      };

      if (step.kind === "error") {
        await addText(step.partialText ?? "");
        partial.stopReason = "error";
        partial.errorMessage = step.message;
        out.push({ type: "error", reason: "error", message: snapshot() });
        return;
      }
      if (step.kind === "hang") {
        if (step.text !== undefined) await addText(step.text);
        if (step.toolCalls !== undefined) await addCalls(step.toolCalls);
        if (!aborted()) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return finishAborted();
      }
      if (step.thinking !== undefined) {
        const index = partial.content.length;
        partial.content.push({
          type: "thinking",
          thinking: step.thinking,
          thinkingSignature: "sig",
        });
        out.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
        out.push({
          type: "thinking_delta",
          contentIndex: index,
          delta: step.thinking,
          partial: snapshot(),
        });
        out.push({ type: "thinking_end", contentIndex: index, partial: snapshot() });
      }
      if (step.text !== undefined) await addText(step.text);
      if (aborted()) return finishAborted();
      if (step.toolCalls !== undefined) await addCalls(step.toolCalls);
      if (aborted()) return finishAborted();
      const outputTokens = Math.ceil(contextChars([{ ...partial, content: partial.content }]) / 4);
      partial.usage = {
        input: inputTokens,
        output: outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: inputTokens + outputTokens,
        ...step.usage,
      };
      const reason = step.stopReason ?? (step.toolCalls?.length ? "toolUse" : "stop");
      partial.stopReason = reason;
      out.push({ type: "done", reason, message: snapshot() });
    })();
    return out;
  };

  return { api: { id, stream }, calls };
}
