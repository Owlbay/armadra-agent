/**
 * anthropic-messages 协议（设计 §3.1）：POST `{baseUrl}/v1/messages`（stream），SSE → 事件。
 *
 * SSE 事件：message_start（id、初始 usage）→ content_block_start / delta / stop（text、
 * thinking + signature_delta、redacted_thinking、tool_use + input_json_delta）→ message_delta
 * （stop_reason、累计 usage）→ message_stop。`event: error` 或缺 message_stop 都编码为 error。
 *
 * usage：`input_tokens` 本就不含缓存；`cache_read_input_tokens` → cacheRead，
 * `cache_creation_input_tokens` → cacheWrite，`cache_creation.ephemeral_1h_input_tokens` →
 * cacheWrite1h。message_delta 只覆盖非 null 字段（部分代理在 delta 里省略 input）。两个缓存字段
 * 任一出现过（含 0）即 `cacheReported: true`，之后的事件不会把它改回 false。
 */

import { AssistantEventStreamImpl } from "../event-stream.js";
import {
  USER_AGENT,
  authHeaders,
  describeErrorJson,
  joinUrl,
  mergeHeaders,
  postJson,
} from "../http.js";
import { readSseEvents } from "../sse.js";
import type {
  AnthropicMessagesCompat,
  ApiImplementation,
  AssistantEventStream,
  Model,
  StreamOptions,
  TranscriptContext,
  Usage,
} from "../types.js";
import {
  ANTHROPIC_VERSION,
  buildAnthropicRequest,
  detectAnthropicCompat,
} from "./anthropic-request.js";
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

/** 把 Anthropic usage 字段写进 Usage（只覆盖出现且非 null 的字段）。 */
export function applyAnthropicUsage(usage: Usage, raw: Json | undefined): void {
  if (!raw) return;
  const input = num(raw["input_tokens"]);
  const output = num(raw["output_tokens"]);
  const cacheRead = num(raw["cache_read_input_tokens"]);
  const cacheWrite = num(raw["cache_creation_input_tokens"]);
  const longWrite = num(obj(raw["cache_creation"])?.["ephemeral_1h_input_tokens"]);
  const reasoning = num(obj(raw["output_tokens_details"])?.["thinking_tokens"]);
  if (input !== undefined) usage.input = input;
  if (output !== undefined) usage.output = output;
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  if (cacheRead !== undefined || cacheWrite !== undefined) usage.cacheReported = true;
  else usage.cacheReported ??= false;
  if (longWrite !== undefined) usage.cacheWrite1h = longWrite;
  if (reasoning !== undefined) usage.reasoning = reasoning;
}

type MappedStop = { reason: "stop" | "length" | "toolUse" } | { reason: "error"; message: string };

export function mapAnthropicStop(raw: string, details?: Json): MappedStop {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return { reason: "stop" };
    case "max_tokens":
      return { reason: "length" };
    case "tool_use":
      return { reason: "toolUse" };
    case "refusal":
      return {
        reason: "error",
        message: str(details?.["explanation"]) ?? "The model refused to respond (refusal)",
      };
    case "model_context_window_exceeded":
      return { reason: "error", message: "model_context_window_exceeded: prompt is too long" };
    default:
      return { reason: "stop" };
  }
}

function buildHeaders(
  model: Model,
  options: StreamOptions,
  betas: string[],
): Record<string, string> {
  return mergeHeaders(
    {
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": ANTHROPIC_VERSION,
      "user-agent": USER_AGENT,
      ...(betas.length > 0 ? { "anthropic-beta": betas.join(",") } : {}),
    },
    authHeaders(options.apiKey, model.authHeader, "x-api-key"),
    model.headers,
    options.headers,
  );
}

interface StreamState {
  /** Anthropic 块 index → content 下标。 */
  readonly blocks: Map<number, number>;
  stop: MappedStop | undefined;
  sawMessageStop: boolean;
}

function handleEvent(data: Json, state: StreamState, tracker: BlockTracker): void {
  const output = tracker.output;
  const type = str(data["type"]);
  if (type === "message_start") {
    const message = obj(data["message"]);
    const id = str(message?.["id"]);
    if (id) output.responseId = id;
    applyAnthropicUsage(output.usage, obj(message?.["usage"]));
  } else if (type === "content_block_start") {
    const index = num(data["index"]) ?? state.blocks.size;
    const block = obj(data["content_block"]);
    const kind = str(block?.["type"]);
    if (kind === "text") {
      state.blocks.set(index, tracker.startText(str(block?.["text"]) ?? ""));
    } else if (kind === "thinking") {
      const signature = str(block?.["signature"]);
      state.blocks.set(index, tracker.startThinking(str(block?.["thinking"]) ?? "", signature));
    } else if (kind === "redacted_thinking") {
      const data = str(block?.["data"]) ?? "";
      state.blocks.set(index, tracker.startThinking("[redacted]", data, true));
    } else if (kind === "tool_use") {
      const input = obj(block?.["input"]) ?? {};
      const id = str(block?.["id"]) ?? `toolu_${index}`;
      state.blocks.set(index, tracker.startToolCall(id, str(block?.["name"]) ?? "", input));
    }
  } else if (type === "content_block_delta") {
    const target = state.blocks.get(num(data["index"]) ?? -1);
    const delta = obj(data["delta"]);
    if (target === undefined || !delta) return;
    const kind = str(delta["type"]);
    if (kind === "text_delta") tracker.appendText(target, str(delta["text"]) ?? "");
    else if (kind === "thinking_delta")
      tracker.appendThinking(target, str(delta["thinking"]) ?? "");
    else if (kind === "signature_delta")
      tracker.appendSignature(target, str(delta["signature"]) ?? "");
    else if (kind === "input_json_delta")
      tracker.appendToolArgs(target, str(delta["partial_json"]) ?? "");
  } else if (type === "content_block_stop") {
    const target = state.blocks.get(num(data["index"]) ?? -1);
    if (target !== undefined) tracker.end(target);
  } else if (type === "message_delta") {
    const delta = obj(data["delta"]);
    const raw = str(delta?.["stop_reason"]);
    if (raw) {
      output.rawStopReason = raw;
      state.stop = mapAnthropicStop(raw, obj(delta?.["stop_details"]));
    }
    applyAnthropicUsage(output.usage, obj(data["usage"]));
  } else if (type === "message_stop") {
    state.sawMessageStop = true;
  } else if (type === "error") {
    throw new Error(describeErrorJson(data) ?? JSON.stringify(data));
  }
}

async function run(
  stream: AssistantEventStreamImpl,
  model: Model,
  context: TranscriptContext,
  options: StreamOptions,
): Promise<void> {
  const tracker = new BlockTracker(stream, createOutput(model));
  try {
    const request = buildAnthropicRequest(model, context, options);
    tracker.output.thinkingLevel = request.thinkingLevel;
    if (request.providerThinkingLevel !== undefined) {
      tracker.output.providerThinkingLevel = request.providerThinkingLevel;
    }
    const replaced = options.onPayload?.(request.body);
    const body = replaced === undefined ? request.body : replaced;
    const baseUrl = model.baseUrl ?? "https://api.anthropic.com";
    const response = await postJson(joinUrl(baseUrl, "/v1/messages"), {
      headers: buildHeaders(model, options, request.betas),
      body,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onResponse: options.onResponse,
    });
    stream.push({ type: "start", partial: tracker.output });
    const state: StreamState = { blocks: new Map(), stop: undefined, sawMessageStop: false };
    for await (const sse of readSseEvents(
      response.body as ReadableStream<Uint8Array>,
      options.signal,
    )) {
      if (sse.event === "ping" || sse.data === "") continue;
      let data: Json;
      try {
        data = obj(JSON.parse(sse.data)) ?? {};
      } catch {
        throw new Error(
          `Malformed SSE data (${sse.event ?? "message"}): ${sse.data.slice(0, 200)}`,
        );
      }
      if (sse.event === "error" && data["type"] !== "error") data = { type: "error", error: data };
      handleEvent(data, state, tracker);
      if (state.sawMessageStop) break;
    }
    if (options.signal.aborted) throw new Error("aborted");
    if (!state.sawMessageStop) throw new Error(STREAM_ENDED_MESSAGE);
    const stop = state.stop ?? { reason: tracker.hasToolCalls ? "toolUse" : "stop" };
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

export const anthropicMessagesApi: ApiImplementation<AnthropicMessagesCompat> = {
  id: "anthropic-messages",
  stream,
  detectCompat: detectAnthropicCompat,
};
