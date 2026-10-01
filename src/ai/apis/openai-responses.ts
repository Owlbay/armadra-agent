/**
 * openai-responses 协议（设计 §3.1）：POST `{baseUrl}/responses`（stream），`event: response.*` →
 * 事件；没有 `[DONE]`，以 `response.completed / incomplete / failed` 结束。
 *
 * - 每个 output item 一个内容块（按 `output_index` 对应，缺省时按 item id）：reasoning → 思考、
 *   message → 文本、function_call → 工具调用；`output_item.done` 关块并记签名：reasoning 记完整
 *   item（含 `encrypted_content`，供无状态回放），message 记 id / phase，function_call 记 `fc_` id；
 * - 思考文本来自 `reasoning_summary_text.delta`（多段 summary 之间空一行）或
 *   `reasoning_text.delta`；增量缺失而 done 里有全文时补齐；
 * - `function_call_arguments.done` 与已拼接的增量不一致时以前缀补齐；
 * - 停止：completed → stop（有工具调用则 toolUse）；incomplete + max_output_tokens → length，其它
 *   incomplete 原因 → error；failed / `error` 事件 → error（`code: message`）；无终止事件 → 断流；
 * - usage：input = input_tokens − input_tokens_details.cached_tokens，reasoning =
 *   output_tokens_details.reasoning_tokens（已含在 output_tokens 里）。
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
  ApiImplementation,
  AssistantEventStream,
  Model,
  OpenAIResponsesCompat,
  StreamOptions,
  TextBlock,
  TranscriptContext,
  Usage,
} from "../types.js";
import {
  buildResponsesRequest,
  detectResponsesCompat,
  encodeMessageSignature,
} from "./openai-responses-request.js";
import {
  BlockTracker,
  ProviderStopError,
  STREAM_ENDED_MESSAGE,
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

export function parseResponsesUsage(raw: Json): Usage {
  const input = num(raw["input_tokens"]) ?? 0;
  const cacheRead = num(obj(raw["input_tokens_details"])?.["cached_tokens"]) ?? 0;
  const usage: Usage = {
    input: Math.max(0, input - cacheRead),
    output: num(raw["output_tokens"]) ?? 0,
    cacheRead,
    cacheWrite: 0,
    totalTokens: 0,
  };
  const reasoning = num(obj(raw["output_tokens_details"])?.["reasoning_tokens"]);
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return usage;
}

type MappedStop = { reason: "stop" | "length" } | { reason: "error"; message: string };

export function mapResponsesStatus(status: string | undefined, incomplete?: string): MappedStop {
  if (status === "incomplete") {
    if (incomplete === "max_output_tokens") return { reason: "length" };
    return {
      reason: "error",
      message: incomplete ? `Response incomplete: ${incomplete}` : "Response incomplete",
    };
  }
  if (status === "failed" || status === "cancelled") {
    return { reason: "error", message: `Response ${status}` };
  }
  return { reason: "stop" };
}

interface Slot {
  index: number;
  kind: "thinking" | "text" | "toolCall";
}

interface StreamState {
  readonly byOutput: Map<number, Slot>;
  readonly byItem: Map<string, Slot>;
  /** 内容下标 → 已拼接的参数 JSON。 */
  readonly args: Map<number, string>;
  stop: MappedStop | undefined;
}

function appendArgs(state: StreamState, tracker: BlockTracker, index: number, delta: string): void {
  if (delta.length === 0) return;
  state.args.set(index, (state.args.get(index) ?? "") + delta);
  tracker.appendToolArgs(index, delta);
}

/** done 给出的全文与已拼接的增量对齐：是前缀则补尾巴，尚无增量则整段补上。 */
function reconcileArgs(state: StreamState, tracker: BlockTracker, index: number, full: string) {
  const sofar = state.args.get(index) ?? "";
  if (full.startsWith(sofar)) appendArgs(state, tracker, index, full.slice(sofar.length));
}

function slotOf(state: StreamState, data: Json, kind: Slot["kind"]): Slot | undefined {
  const outputIndex = num(data["output_index"]);
  const itemId = str(data["item_id"]) ?? str(obj(data["item"])?.["id"]);
  const slot =
    (outputIndex !== undefined ? state.byOutput.get(outputIndex) : undefined) ??
    (itemId !== undefined ? state.byItem.get(itemId) : undefined);
  return slot?.kind === kind ? slot : undefined;
}

function openSlot(state: StreamState, data: Json, tracker: BlockTracker): Slot | undefined {
  const item = obj(data["item"]);
  const type = str(item?.["type"]);
  let slot: Slot | undefined;
  if (type === "reasoning") slot = { index: tracker.startThinking(), kind: "thinking" };
  else if (type === "message") slot = { index: tracker.startText(), kind: "text" };
  else if (type === "function_call") {
    const callId = str(item?.["call_id"]) || str(item?.["id"]) || `call_${state.byOutput.size}`;
    const index = tracker.startToolCall(callId, str(item?.["name"]) ?? "");
    const block = tracker.toolCallBlock(index);
    const itemId = str(item?.["id"]);
    if (block && itemId) block.thoughtSignature = itemId;
    slot = { index, kind: "toolCall" };
    appendArgs(state, tracker, index, str(item?.["arguments"]) ?? "");
  }
  if (!slot) return undefined;
  const outputIndex = num(data["output_index"]);
  if (outputIndex !== undefined) state.byOutput.set(outputIndex, slot);
  const itemId = str(item?.["id"]);
  if (itemId) state.byItem.set(itemId, slot);
  return slot;
}

function texts(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((part) => str(obj(part)?.[field]) ?? "").filter((t) => t.length > 0);
}

function closeSlot(state: StreamState, data: Json, tracker: BlockTracker): void {
  const item = obj(data["item"]) ?? {};
  const type = str(item["type"]);
  const kind = type === "reasoning" ? "thinking" : type === "message" ? "text" : "toolCall";
  if (type !== "reasoning" && type !== "message" && type !== "function_call") return;
  const slot = slotOf(state, data, kind) ?? openSlot(state, data, tracker);
  if (!slot || !tracker.isOpen(slot.index)) return;
  const block = tracker.output.content[slot.index];
  if (type === "reasoning" && block?.type === "thinking") {
    if (block.thinking.length === 0) {
      const full = texts(item["summary"], "text");
      const raw = full.length > 0 ? full : texts(item["content"], "text");
      tracker.appendThinking(slot.index, raw.join("\n\n"));
    }
    block.thinkingSignature = JSON.stringify(item);
  } else if (type === "message" && block?.type === "text") {
    if (block.text.length === 0) {
      const parts = Array.isArray(item["content"]) ? item["content"] : [];
      const full = parts.map((p) => str(obj(p)?.["text"]) ?? str(obj(p)?.["refusal"]) ?? "");
      tracker.appendText(slot.index, full.join(""));
    }
    const id = str(item["id"]);
    if (id) (block as TextBlock).textSignature = encodeMessageSignature(id, str(item["phase"]));
  } else if (type === "function_call" && block?.type === "toolCall") {
    const args = str(item["arguments"]);
    if (args !== undefined) reconcileArgs(state, tracker, slot.index, args);
  }
  tracker.end(slot.index);
}

/** 处理一个事件；返回 true 表示已到终止事件。 */
function handleEvent(data: Json, state: StreamState, tracker: BlockTracker): boolean {
  const output = tracker.output;
  const type = str(data["type"]);
  switch (type) {
    case "response.created":
    case "response.in_progress": {
      const id = str(obj(data["response"])?.["id"]);
      if (id && !output.responseId) output.responseId = id;
      return false;
    }
    case "response.output_item.added":
      openSlot(state, data, tracker);
      return false;
    case "response.reasoning_summary_part.added": {
      const slot = slotOf(state, data, "thinking");
      const block = slot ? output.content[slot.index] : undefined;
      if (slot && (num(data["summary_index"]) ?? 0) > 0 && block?.type === "thinking") {
        if (block.thinking.length > 0) tracker.appendThinking(slot.index, "\n\n");
      }
      return false;
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      const slot = slotOf(state, data, "thinking");
      if (slot) tracker.appendThinking(slot.index, str(data["delta"]) ?? "");
      return false;
    }
    case "response.output_text.delta":
    case "response.refusal.delta": {
      const slot = slotOf(state, data, "text");
      if (slot) tracker.appendText(slot.index, str(data["delta"]) ?? "");
      return false;
    }
    case "response.function_call_arguments.delta": {
      const slot = slotOf(state, data, "toolCall");
      if (slot) appendArgs(state, tracker, slot.index, str(data["delta"]) ?? "");
      return false;
    }
    case "response.function_call_arguments.done": {
      const slot = slotOf(state, data, "toolCall");
      const full = str(data["arguments"]);
      if (slot && full !== undefined) reconcileArgs(state, tracker, slot.index, full);
      return false;
    }
    case "response.output_item.done":
      closeSlot(state, data, tracker);
      return false;
    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      const response = obj(data["response"]) ?? {};
      const id = str(response["id"]);
      if (id) output.responseId = id;
      const usage = obj(response["usage"]);
      if (usage) output.usage = parseResponsesUsage(usage);
      const status = str(response["status"]) ?? type.slice("response.".length);
      const reason = str(obj(response["incomplete_details"])?.["reason"]);
      output.rawStopReason = reason ?? status;
      if (type === "response.failed") {
        const error = obj(response["error"]);
        throw new Error(
          (error ? describeErrorJson({ error }) : undefined) ??
            (reason ? `Response failed: ${reason}` : "Response failed"),
        );
      }
      state.stop = mapResponsesStatus(status, reason);
      return true;
    }
    case "error":
      throw new Error(describeErrorJson(data) ?? JSON.stringify(data));
    default:
      return false;
  }
}

function buildHeaders(model: Model, options: StreamOptions): Record<string, string> {
  return mergeHeaders(
    { "content-type": "application/json", accept: "text/event-stream", "user-agent": USER_AGENT },
    authHeaders(options.apiKey, model.authHeader, "authorization-bearer"),
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
    const request = buildResponsesRequest(model, context, options);
    tracker.output.thinkingLevel = request.thinkingLevel;
    if (request.providerThinkingLevel !== undefined) {
      tracker.output.providerThinkingLevel = request.providerThinkingLevel;
    }
    const replaced = options.onPayload?.(request.body);
    const baseUrl = model.baseUrl ?? "https://api.openai.com/v1";
    const response = await postJson(joinUrl(baseUrl, "/responses"), {
      headers: buildHeaders(model, options),
      body: replaced === undefined ? request.body : replaced,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onResponse: options.onResponse,
    });
    stream.push({ type: "start", partial: tracker.output });
    const state: StreamState = {
      byOutput: new Map(),
      byItem: new Map(),
      args: new Map(),
      stop: undefined,
    };
    let finished = false;
    const body = response.body as ReadableStream<Uint8Array>;
    for await (const sse of readSseEvents(body, options.signal)) {
      const raw = sse.data.trim();
      if (raw === "" || raw === "[DONE]") continue;
      let data: Json;
      try {
        data = obj(JSON.parse(raw)) ?? {};
      } catch {
        throw new Error(`Malformed SSE data (${sse.event ?? "message"}): ${raw.slice(0, 200)}`);
      }
      if (data["type"] === undefined && sse.event) data["type"] = sse.event;
      if (handleEvent(data, state, tracker)) {
        finished = true;
        break;
      }
    }
    if (options.signal.aborted) throw new Error("aborted");
    if (!finished || !state.stop) throw new Error(STREAM_ENDED_MESSAGE);
    if (state.stop.reason === "error") throw new ProviderStopError(state.stop.message);
    const reason =
      state.stop.reason === "stop" && tracker.hasToolCalls ? "toolUse" : state.stop.reason;
    finishDone(stream, tracker, model, reason);
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

export const openAIResponsesApi: ApiImplementation<OpenAIResponsesCompat> = {
  id: "openai-responses",
  stream,
  detectCompat: detectResponsesCompat,
};
