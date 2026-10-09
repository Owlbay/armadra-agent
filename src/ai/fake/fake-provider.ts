/**
 * 脚本化供应商（设计 D16、§15）：供应商 id `fake`、协议 id `fake`，模型 `fake/echo`、
 * `fake/reasoning`。无脚本时回显最后一条用户消息；有脚本时第 n 次调用（跨模型计数）按
 * `responses[n]` 产出文本 / 思考 / 工具调用 / 429 / 溢出 / 断流 / 延迟。
 *
 * 事件形状与真实协议完全一致（同一个 BlockTracker），契约测试对两条协议与 fake 跑同一套断言。
 * [ME-C] 工具参数按 JSON 串分块喂给 BlockTracker，所以消息同样带 `rawArguments`；start 之前的错误
 * 以 `HttpError` 抛出（状态 ≥ 400 时），脚本的 `error.retryAfterMs` 进失败消息的 `retryAfterMs`。
 *
 * 用法：
 * - 测试：`const fake = new FakeProvider([...])`，把 `fake.api` 注册进 ApiRegistry（或直接
 *   `fake.api.stream(...)`），`fake.calls` 记录每次调用的上下文与选项；
 * - CLI：`--provider fake`；`AMA_FAKE_SCRIPT=<path.json>` 指定脚本（首次调用时读取）。
 * - 录制（第三波 §2.4，bundle 级缓存测试）：`AMA_FAKE_RECORD=<file>` 时每次请求向文件追加一行
 *   JSON `{ index, purpose, model, system, tools, messagesCount }`——`system` 是折叠后的系统提示
 *   原文，`tools` 是发给供应商的工具表（按注册顺序），与真实协议请求体的前缀同口径。
 */

import { appendFileSync } from "node:fs";

import { AssistantEventStreamImpl } from "../event-stream.js";
import {
  BlockTracker,
  ProviderStopError,
  createOutput,
  finishDone,
  finishError,
} from "../apis/shared.js";
import { contentText, normalizeContext } from "../context.js";
import { HttpError } from "../http.js";
import type {
  ApiImplementation,
  AssistantEventStream,
  Model,
  ProviderData,
  StreamOptions,
  TranscriptContext,
} from "../types.js";
import {
  describeFakeError,
  loadFakeScript,
  parseFakeScript,
  type FakeResponse,
  type FakeScript,
  type FakeStep,
} from "./fake-script.js";

export const FAKE_PROVIDER_ID = "fake";
export const FAKE_API_ID = "fake";
export const FAKE_SCRIPT_ENV = "AMA_FAKE_SCRIPT";
export const FAKE_RECORD_ENV = "AMA_FAKE_RECORD";

/** `AMA_FAKE_RECORD` 文件的一行。 */
export interface FakeRecordLine {
  index: number;
  purpose: string;
  model: string;
  system: string;
  tools: unknown[];
  messagesCount: number;
}

export interface FakeProviderOptions {
  /** 录制文件路径（每次请求取一次；undefined = 不录）。 */
  recordFile?: string | (() => string | undefined);
}

const FAKE_MODEL_BASE = {
  provider: FAKE_PROVIDER_ID,
  api: FAKE_API_ID,
  baseUrl: "fake://local",
  input: ["text", "image"] as ("text" | "image")[],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  requiresApiKey: false,
};

export const FAKE_MODELS: readonly Model[] = [
  { ...FAKE_MODEL_BASE, id: "echo", name: "Fake Echo", reasoning: false },
  { ...FAKE_MODEL_BASE, id: "reasoning", name: "Fake Reasoning", reasoning: true },
];

export function fakeProviderData(): ProviderData {
  return {
    id: FAKE_PROVIDER_ID,
    name: "Fake (scripted)",
    api: FAKE_API_ID,
    baseUrl: "fake://local",
    envKeys: [],
    models: FAKE_MODELS.map((model) => ({ ...model })),
    requiresApiKey: false,
    builtin: true,
  };
}

export interface FakeCall {
  /** 从 0 开始。 */
  index: number;
  model: Model;
  context: TranscriptContext;
  options: Omit<StreamOptions, "signal" | "onPayload" | "onResponse">;
}

function lastUserText(context: TranscriptContext): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message?.role === "user") return contentText(message.content);
  }
  return "";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function contextChars(context: TranscriptContext): number {
  let chars = 0;
  for (const message of context.messages) chars += JSON.stringify(message).length;
  return chars;
}

function chunks(text: string, size: number | undefined): string[] {
  if (!size || size <= 0 || text.length <= size) return text.length > 0 ? [text] : [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      setTimeout(resolve, 0);
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** 让出事件循环，abort 能在两个事件之间插入。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class AbortedError extends Error {}

export class FakeProvider {
  readonly calls: FakeCall[] = [];
  private script: FakeScript | undefined;
  private readonly scriptLoader: (() => FakeScript | undefined) | undefined;
  private loaded = false;
  private readonly recordFile: () => string | undefined;

  constructor(
    script?: FakeScript | FakeResponse[] | (() => FakeScript | undefined),
    options: FakeProviderOptions = {},
  ) {
    if (typeof script === "function") this.scriptLoader = script;
    else if (script !== undefined) this.setScript(script);
    const record = options.recordFile;
    this.recordFile = typeof record === "function" ? record : () => record;
  }

  readonly api: ApiImplementation = {
    id: FAKE_API_ID,
    stream: (model, context, options) => this.stream(model, context, options),
  };

  get callCount(): number {
    return this.calls.length;
  }

  setScript(script: FakeScript | FakeResponse[]): void {
    this.script = parseFakeScript(script);
    this.loaded = true;
  }

  append(...responses: FakeResponse[]): void {
    this.ensureLoaded();
    this.script ??= { version: 1, responses: [] };
    this.script.responses.push(...responses);
  }

  reset(): void {
    this.calls.length = 0;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.script = this.scriptLoader?.();
  }

  /** 第 index 次调用的响应；undefined = 回显。 */
  private responseFor(index: number): FakeResponse | undefined {
    this.ensureLoaded();
    const script = this.script;
    if (!script) return undefined;
    const direct = script.responses[index];
    if (direct) return direct;
    const behavior = script.whenExhausted ?? "echo";
    if (behavior === "repeat-last") return script.responses[script.responses.length - 1];
    if (behavior === "error") {
      return { error: { kind: "custom", message: `fake script exhausted at call ${index + 1}` } };
    }
    return undefined;
  }

  stream(model: Model, context: TranscriptContext, options: StreamOptions): AssistantEventStream {
    const index = this.calls.length;
    const { signal: _s, onPayload: _p, onResponse: _r, ...rest } = options;
    this.calls.push({ index, model, context, options: rest });
    this.record(index, model, context, options);
    const response = this.responseFor(index) ?? {
      text: lastUserText(context) || "(no input)",
    };
    const events = new AssistantEventStreamImpl();
    void this.run(events, model, context, options, response).finally(() => events.end());
    return events;
  }

  /** 录制一行；写失败不影响请求（测试会因缺行而失败）。 */
  private record(
    index: number,
    model: Model,
    context: TranscriptContext,
    options: StreamOptions,
  ): void {
    const file = this.recordFile();
    if (!file) return;
    const normalized = normalizeContext(context);
    const line: FakeRecordLine = {
      index,
      purpose: options.purpose ?? "turn",
      model: `${model.provider}/${model.id}`,
      system: normalized.systemPrompt,
      tools: normalized.tools,
      messagesCount: normalized.messages.length,
    };
    try {
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch {
      // 录制只服务测试；路径不可写时静默。
    }
  }

  private async run(
    stream: AssistantEventStreamImpl,
    model: Model,
    context: TranscriptContext,
    options: StreamOptions,
    response: FakeResponse,
  ): Promise<void> {
    const tracker = new BlockTracker(stream, createOutput(model));
    const { signal } = options;
    const checkAbort = (): void => {
      if (signal.aborted) throw new AbortedError("aborted");
    };
    try {
      options.onPayload?.({ fake: true, model: model.id, messages: context.messages.length });
      if (response.delayMs) await sleep(response.delayMs, signal);
      checkAbort();
      const error = response.error ? describeFakeError(response.error) : undefined;
      if (error && response.error?.kind !== "disconnect") {
        options.onResponse?.(error.status, new Headers());
        if (error.status < 400) throw new Error(error.message);
        throw new HttpError(error.status, error.message, "", response.error?.retryAfterMs);
      }
      options.onResponse?.(200, new Headers({ "content-type": "text/event-stream" }));
      if (options.thinkingLevel) tracker.output.thinkingLevel = options.thinkingLevel;
      stream.push({ type: "start", partial: tracker.output });
      const steps: FakeStep[] = [...(response.steps ?? [])];
      if (response.text !== undefined) steps.push({ text: response.text });
      let produced = "";
      for (const step of steps) {
        await tick();
        checkAbort();
        produced += await this.emitStep(step, tracker, signal);
      }
      await tick();
      checkAbort();
      const usage = tracker.output.usage;
      usage.input = response.usage?.input ?? Math.ceil(contextChars(context) / 4);
      usage.output = response.usage?.output ?? estimateTokens(produced);
      usage.cacheRead = response.usage?.cacheRead ?? 0;
      usage.cacheWrite = response.usage?.cacheWrite ?? 0;
      if (error) throw new Error(error.message);
      if (response.stopReason === "refusal") {
        tracker.output.rawStopReason = "refusal";
        throw new ProviderStopError("The model refused to respond (refusal)");
      }
      const reason = response.stopReason ?? (tracker.hasToolCalls ? "toolUse" : "stop");
      finishDone(stream, tracker, model, reason);
    } catch (error) {
      finishError(stream, tracker, model, error, signal);
    }
  }

  /** 产出一步，返回产出的文本（估算 output token 用）。 */
  private async emitStep(
    step: FakeStep,
    tracker: BlockTracker,
    signal: AbortSignal,
  ): Promise<string> {
    if ("delayMs" in step) {
      await sleep(step.delayMs, signal);
      return "";
    }
    if ("text" in step) {
      const index = tracker.startText();
      for (const part of chunks(step.text, step.chunkSize)) {
        tracker.appendText(index, part);
        await tick();
        if (signal.aborted) throw new AbortedError("aborted");
      }
      tracker.end(index);
      return step.text;
    }
    if ("thinking" in step) {
      const index = tracker.startThinking("", step.signature ?? "fake-signature");
      for (const part of chunks(step.thinking, step.chunkSize)) {
        tracker.appendThinking(index, part);
        await tick();
        if (signal.aborted) throw new AbortedError("aborted");
      }
      tracker.end(index);
      return step.thinking;
    }
    const id = step.toolCall.id ?? `fake_call_${tracker.output.content.length}`;
    const index = tracker.startToolCall(id, step.toolCall.name);
    const json = JSON.stringify(step.toolCall.arguments ?? {});
    for (const part of chunks(json, step.chunkSize)) {
      tracker.appendToolArgs(index, part);
      await tick();
      if (signal.aborted) throw new AbortedError("aborted");
    }
    tracker.end(index);
    return json;
  }
}

/** 进程级缺省实例（`--provider fake`）：脚本来自 AMA_FAKE_SCRIPT，录制到 AMA_FAKE_RECORD。 */
export const defaultFakeProvider = new FakeProvider(
  () => {
    const path = process.env[FAKE_SCRIPT_ENV];
    return path ? loadFakeScript(path) : undefined;
  },
  { recordFile: () => process.env[FAKE_RECORD_ENV] || undefined },
);

export const fakeApi: ApiImplementation = defaultFakeProvider.api;
