/**
 * openai-completions 协议（设计 §3.1、§3.3）：POST `{baseUrl}/chat/completions`（stream），
 * `data:` 块 → 事件，`data: [DONE]` 结束。
 *
 * - 文本：`delta.content`；思考：`delta.reasoning_content` / `reasoning` / `reasoning_text`
 *   取第一个非空字段，字段名记进 `thinkingSignature`（回放时放回同名字段）；
 * - 工具调用增量按 `index` 拼接；缺 index 按 `id`；两者都缺则续到最近一个工具调用；
 * - usage 三个位置：`chunk.usage`（标准）、`chunk.x_groq.usage`（Groq）、`choices[0].usage`
 *   （Moonshot）；缓存命中三种字段：`prompt_tokens_details.cached_tokens`（OpenAI /
 *   OpenRouter）、`prompt_cache_hit_tokens`（DeepSeek）、顶层 `cached_tokens`（Moonshot）；任一缓存
 *   字段出现（含 0）即 `cacheReported: true`，都没有为 false（第三波 §1.6）；
 * - 结束证据是 finish_reason 或 `[DONE]`；两者都没有 → 断流错误。finish_reason 为 stop 但
 *   有工具调用时按 toolUse（部分本地服务如此返回）；`supportsFinishReason: false` 时完全按
 *   内容推断。
 */

import { AssistantEventStreamImpl } from "../event-stream.js";
import {
  authHeaders,
  describeErrorJson,
  idleTimeoutOf,
  streamIdleTimeoutOf,
  joinUrl,
  mergeHeaders,
  USER_AGENT,
} from "../http.js";
import { readSseEvents } from "../sse.js";
import type {
  ApiImplementation,
  AssistantEventStream,
  Model,
  OpenAICompletionsCompat,
  StreamOptions,
  TranscriptContext,
  Usage,
} from "../types.js";
import { affinityHeaders, resolveCacheRetention } from "./cache-params.js";
import { clampRequestMaxTokens, postWithMaxTokensFallback } from "./max-tokens.js";
import { detectCompat } from "./openai-compat.js";
import { REASONING_FIELDS, buildOpenAIRequest } from "./openai-request.js";
import {
  BlockTracker,
  STREAM_ENDED_MESSAGE,
  ProviderStopError,
  createOutput,
  finishDone,
  finishError,
  requireApiKey,
} from "./shared.js";

type Json = Record<string, unknown>;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** OpenAI 兼容 usage → Usage（input 去掉缓存部分）。 */
export function parseOpenAIUsage(raw: Json): Usage {
  const prompt = num(raw["prompt_tokens"]) ?? 0;
  const details = obj(raw["prompt_tokens_details"]);
  const cacheRead =
    num(details?.["cached_tokens"]) ??
    num(raw["prompt_cache_hit_tokens"]) ??
    num(raw["cached_tokens"]) ??
    0;
  const cacheWrite = num(details?.["cache_write_tokens"]) ?? 0;
  const output = num(raw["completion_tokens"]) ?? 0;
  const cacheFields = [
    details?.["cached_tokens"],
    details?.["cache_write_tokens"],
    raw["prompt_cache_hit_tokens"],
    raw["prompt_cache_miss_tokens"],
    raw["cached_tokens"],
  ];
  const usage: Usage = {
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    totalTokens: 0,
    cacheReported: cacheFields.some((value) => num(value) !== undefined),
  };
  const reasoning = num(obj(raw["completion_tokens_details"])?.["reasoning_tokens"]);
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return usage;
}

type MappedFinish =
  { reason: "stop" | "length" | "toolUse" } | { reason: "error"; message: string };

const ERROR_FINISH = new Set([
  "content_filter",
  "network_error",
  "sensitive",
  "model_context_window_exceeded",
]);

export function mapFinishReason(raw: string): MappedFinish {
  if (raw === "length") return { reason: "length" };
  if (raw === "tool_calls" || raw === "function_call") return { reason: "toolUse" };
  if (ERROR_FINISH.has(raw)) return { reason: "error", message: `Provider finish_reason: ${raw}` };
  return { reason: "stop" };
}

interface StreamState {
  text: number | undefined;
  thinking: number | undefined;
  lastTool: number | undefined;
  readonly toolsByIndex: Map<number, number>;
  readonly toolsById: Map<string, number>;
  finish: string | undefined;
  sawDone: boolean;
}

function closeProse(state: StreamState, tracker: BlockTracker): void {
  if (state.text !== undefined) tracker.end(state.text);
  if (state.thinking !== undefined) tracker.end(state.thinking);
  state.text = undefined;
  state.thinking = undefined;
}

function handleToolCalls(calls: unknown[], state: StreamState, tracker: BlockTracker): void {
  closeProse(state, tracker);
  for (const raw of calls) {
    const call = obj(raw);
    if (!call) continue;
    const streamIndex = num(call["index"]);
    const id = str(call["id"]) || undefined;
    const fn = obj(call["function"]);
    const name = str(fn?.["name"]) || undefined;
    let target = streamIndex !== undefined ? state.toolsByIndex.get(streamIndex) : undefined;
    if (target === undefined && id) target = state.toolsById.get(id);
    if (target === undefined && streamIndex === undefined && !id) target = state.lastTool;
    if (target === undefined || !tracker.isOpen(target)) {
      const generated = `call_${tracker.output.content.length}_${Date.now().toString(36)}`;
      target = tracker.startToolCall(id ?? generated, name ?? "");
    }
    const block = tracker.toolCallBlock(target);
    if (block && id && block.id !== id && !state.toolsById.has(block.id)) block.id = id;
    if (block && name && !block.name) block.name = name;
    if (streamIndex !== undefined) state.toolsByIndex.set(streamIndex, target);
    if (id) state.toolsById.set(id, target);
    state.lastTool = target;
    const args = str(fn?.["arguments"]);
    if (args) tracker.appendToolArgs(target, args);
  }
}

function handleChunk(chunk: Json, state: StreamState, tracker: BlockTracker): void {
  if (chunk["error"] !== undefined) {
    throw new Error(describeErrorJson(chunk) ?? JSON.stringify(chunk["error"]));
  }
  const output = tracker.output;
  const id = str(chunk["id"]);
  if (id && !output.responseId) output.responseId = id;
  const choices = Array.isArray(chunk["choices"]) ? chunk["choices"] : [];
  const choice = obj(choices[0]);
  const rawUsage =
    obj(chunk["usage"]) ?? obj(obj(chunk["x_groq"])?.["usage"]) ?? obj(choice?.["usage"]);
  if (rawUsage) output.usage = parseOpenAIUsage(rawUsage);
  if (!choice) return;
  const delta = obj(choice["delta"]);
  if (delta) {
    const field = REASONING_FIELDS.find((name) => {
      const value = delta[name];
      return typeof value === "string" && value.length > 0;
    });
    if (field) {
      if (state.text !== undefined) {
        tracker.end(state.text);
        state.text = undefined;
      }
      state.thinking ??= tracker.startThinking("", field);
      tracker.appendThinking(state.thinking, delta[field] as string);
    }
    const content = str(delta["content"]);
    if (content) {
      if (state.thinking !== undefined) {
        tracker.end(state.thinking);
        state.thinking = undefined;
      }
      state.text ??= tracker.startText();
      tracker.appendText(state.text, content);
    }
    if (Array.isArray(delta["tool_calls"])) handleToolCalls(delta["tool_calls"], state, tracker);
  }
  const finish = str(choice["finish_reason"]);
  if (finish) {
    state.finish = finish;
    output.rawStopReason = finish;
  }
}

function resolveStop(
  state: StreamState,
  compat: OpenAICompletionsCompat,
  hasToolCalls: boolean,
): MappedFinish {
  const inferred: MappedFinish = { reason: hasToolCalls ? "toolUse" : "stop" };
  if (!compat.supportsFinishReason || state.finish === undefined) return inferred;
  const mapped = mapFinishReason(state.finish);
  return mapped.reason === "stop" && hasToolCalls ? inferred : mapped;
}

function buildHeaders(model: Model, options: StreamOptions): Record<string, string> {
  return mergeHeaders(
    { "content-type": "application/json", accept: "text/event-stream", "user-agent": USER_AGENT },
    authHeaders(options.apiKey, model.authHeader, "authorization-bearer"),
    affinityHeaders(
      model,
      "openai-completions",
      options.sessionId,
      resolveCacheRetention(options.cacheRetention),
    ),
    model.headers,
    options.headers,
  );
}

async function run(
  stream: AssistantEventStreamImpl,
  model: Model,
  context: TranscriptContext,
  options: StreamOptions,
): Promise<void> {
  const tracker = new BlockTracker(stream, createOutput(model));
  try {
    const request = buildOpenAIRequest(model, context, options);
    tracker.output.thinkingLevel = request.thinkingLevel;
    if (request.providerThinkingLevel !== undefined) {
      tracker.output.providerThinkingLevel = request.providerThinkingLevel;
    }
    const field = request.compat.maxTokensField;
    clampRequestMaxTokens(request.body, field, model.contextWindow);
    const replaced = options.onPayload?.(request.body);
    const baseUrl = model.baseUrl ?? "https://api.openai.com/v1";
    const url = joinUrl(baseUrl, "/chat/completions");
    const post = {
      headers: buildHeaders(model, options),
      body: replaced === undefined ? request.body : replaced,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: idleTimeoutOf(options),
      onResponse: options.onResponse,
    };
    const response = await postWithMaxTokensFallback(model, url, post, field);
    stream.push({ type: "start", partial: tracker.output });
    const state: StreamState = {
      text: undefined,
      thinking: undefined,
      lastTool: undefined,
      toolsByIndex: new Map(),
      toolsById: new Map(),
      finish: undefined,
      sawDone: false,
    };
    const body = response.body as ReadableStream<Uint8Array>;
    for await (const sse of readSseEvents(body, options.signal, streamIdleTimeoutOf(options))) {
      const data = sse.data.trim();
      if (data === "") continue;
      if (data === "[DONE]") {
        state.sawDone = true;
        break;
      }
      let chunk: Json;
      try {
        chunk = obj(JSON.parse(data)) ?? {};
      } catch {
        throw new Error(`Malformed SSE data: ${data.slice(0, 200)}`);
      }
      handleChunk(chunk, state, tracker);
    }
    if (options.signal.aborted) throw new Error("aborted");
    if (state.finish === undefined && !state.sawDone) throw new Error(STREAM_ENDED_MESSAGE);
    const stop = resolveStop(state, request.compat, tracker.hasToolCalls);
    if (stop.reason === "error") throw new ProviderStopError(stop.message);
    finishDone(stream, tracker, model, stop.reason);
  } catch (error) {
    finishError(stream, tracker, model, error, options.signal);
  }
}

function stream(
  model: Model,
  context: TranscriptContext,
  options: StreamOptions,
): AssistantEventStream {
  requireApiKey(model, options);
  const events = new AssistantEventStreamImpl();
  void run(events, model, context, options).finally(() => events.end());
  return events;
}

export const openAICompletionsApi: ApiImplementation<OpenAICompletionsCompat> = {
  id: "openai-completions",
  stream,
  detectCompat,
};
