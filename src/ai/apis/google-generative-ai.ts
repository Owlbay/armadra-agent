/**
 * google-generative-ai 协议（设计 §3.1）：POST `{baseUrl}/models/{id}:streamGenerateContent?alt=sse`，
 * 每个 `data:` 是一个完整的 GenerateContentResponse（没有 `[DONE]`）。
 *
 * - `candidates[0].content.parts`：`text`（`thought: true` 为思考）→ 文本 / 思考块，相邻同类 part
 *   并入同一块；`functionCall` 整块到达 → toolcall_start / delta（整段 JSON）/ end；
 * - `thoughtSignature` 可挂在任何 part 上：思考 → `thinkingSignature`，文本 → `textSignature`，
 *   工具调用 → `thoughtSignature`；同一块后到的空签名不覆盖先到的（签名常在末尾的空文本 part 上）；
 * - 工具调用缺 id（Gemini 2.5 起常见）时按 responseId + 内容下标生成确定的 id；
 * - `finishReason`：STOP → stop（有工具调用则 toolUse）、MAX_TOKENS → length，其余（SAFETY、
 *   RECITATION、MALFORMED_FUNCTION_CALL…）→ error；`promptFeedback.blockReason` → error；
 *   流里没出现过 finishReason → 断流错误；
 * - `usageMetadata`（每块累计，取最后一次）：input = promptTokenCount − cachedContentTokenCount，
 *   output = candidatesTokenCount + thoughtsTokenCount（思考按输出计费），reasoning = thoughts；
 * - 错误体 `{error:{code,status,message}}` 重排为 `429 RESOURCE_EXHAUSTED: …`。
 */

import { AssistantEventStreamImpl } from "../event-stream.js";
import { HttpError, USER_AGENT, authHeaders, joinUrl, mergeHeaders, postJson } from "../http.js";
import { readSseEvents } from "../sse.js";
import type {
  ApiImplementation,
  AssistantEventStream,
  GoogleCompat,
  Model,
  StreamOptions,
  TextBlock,
  TranscriptContext,
  Usage,
} from "../types.js";
import { GOOGLE_BASE_URL, buildGoogleRequest, detectGoogleCompat } from "./google-request.js";
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

export function parseGoogleUsage(raw: Json): Usage {
  const prompt = num(raw["promptTokenCount"]) ?? 0;
  const cached = num(raw["cachedContentTokenCount"]) ?? 0;
  const thoughts = num(raw["thoughtsTokenCount"]) ?? 0;
  const usage: Usage = {
    input: Math.max(0, prompt - cached),
    output: (num(raw["candidatesTokenCount"]) ?? 0) + thoughts,
    cacheRead: cached,
    cacheWrite: 0,
    totalTokens: 0,
  };
  if (raw["thoughtsTokenCount"] !== undefined) usage.reasoning = thoughts;
  return usage;
}

type MappedFinish =
  { reason: "stop" | "length" | "toolUse" } | { reason: "error"; message: string };

export function mapGoogleFinishReason(raw: string): MappedFinish {
  if (raw === "STOP") return { reason: "stop" };
  if (raw === "MAX_TOKENS") return { reason: "length" };
  return { reason: "error", message: `Provider finish reason: ${raw}` };
}

/** Google 错误体 `{error:{code,status,message}}` → `status: message`；其它形状返回 undefined。 */
export function describeGoogleError(value: unknown): string | undefined {
  const error = obj(obj(value)?.["error"]);
  if (!error) return undefined;
  const message = str(error["message"]) ?? JSON.stringify(error);
  const status = str(error["status"]);
  return status && !message.startsWith(status) ? `${status}: ${message}` : message;
}

function rewriteHttpError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  let detail: string | undefined;
  try {
    detail = describeGoogleError(JSON.parse(error.body));
  } catch {
    detail = undefined;
  }
  if (!detail) return error;
  return new HttpError(error.status, `${error.status} ${detail}`, error.body, error.retryAfterMs);
}

interface StreamState {
  /** 当前打开的文本 / 思考块。 */
  prose: { index: number; kind: "text" | "thinking" } | undefined;
  finish: string | undefined;
  idSeed: string;
}

function closeProse(state: StreamState, tracker: BlockTracker): void {
  if (state.prose) tracker.end(state.prose.index);
  state.prose = undefined;
}

function setSignature(tracker: BlockTracker, index: number, signature: string): void {
  const block = tracker.output.content[index];
  if (block?.type === "thinking") block.thinkingSignature = signature;
  else if (block?.type === "text") (block as TextBlock).textSignature = signature;
}

function toolCallId(state: StreamState, tracker: BlockTracker, provided: string | undefined) {
  const taken = (id: string): boolean =>
    tracker.output.content.some((b) => b.type === "toolCall" && b.id === id);
  if (provided && !taken(provided)) return provided;
  const seed = state.idSeed.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "gemini";
  let id = `call_${seed}_${tracker.output.content.length}`;
  for (let n = 1; taken(id); n++) id = `call_${seed}_${tracker.output.content.length}_${n}`;
  return id;
}

function handlePart(part: Json, state: StreamState, tracker: BlockTracker): void {
  const signature = str(part["thoughtSignature"]) || undefined;
  const call = obj(part["functionCall"]);
  if (call) {
    closeProse(state, tracker);
    const name = str(call["name"]) ?? "";
    const index = tracker.startToolCall(toolCallId(state, tracker, str(call["id"])), name);
    const block = tracker.toolCallBlock(index);
    if (block && signature) block.thoughtSignature = signature;
    tracker.appendToolArgs(index, JSON.stringify(obj(call["args"]) ?? {}));
    tracker.end(index);
    return;
  }
  const text = str(part["text"]);
  if (text === undefined) return;
  const kind = part["thought"] === true ? "thinking" : "text";
  if (state.prose?.kind !== kind) {
    closeProse(state, tracker);
    // 空 part 不单独开块；只带签名的挂到前一个同类块上
    if (text.length === 0) {
      const last = tracker.output.content.length - 1;
      if (signature && tracker.output.content[last]?.type === kind) {
        setSignature(tracker, last, signature);
      }
      return;
    }
    const index = kind === "thinking" ? tracker.startThinking() : tracker.startText();
    state.prose = { index, kind };
  }
  const index = state.prose.index;
  if (kind === "thinking") tracker.appendThinking(index, text);
  else tracker.appendText(index, text);
  if (signature) setSignature(tracker, index, signature);
}

function handleChunk(chunk: Json, state: StreamState, tracker: BlockTracker): void {
  if (chunk["error"] !== undefined) {
    throw new Error(describeGoogleError(chunk) ?? JSON.stringify(chunk["error"]));
  }
  const output = tracker.output;
  const responseId = str(chunk["responseId"]);
  if (responseId && !output.responseId) {
    output.responseId = responseId;
    state.idSeed = responseId;
  }
  const usage = obj(chunk["usageMetadata"]);
  if (usage) output.usage = parseGoogleUsage(usage);
  const blocked = str(obj(chunk["promptFeedback"])?.["blockReason"]);
  const candidates = Array.isArray(chunk["candidates"]) ? chunk["candidates"] : [];
  const candidate = obj(candidates[0]);
  if (!candidate && blocked) {
    output.rawStopReason = blocked;
    throw new ProviderStopError(`Prompt blocked: ${blocked}`);
  }
  const parts = obj(candidate?.["content"])?.["parts"];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const value = obj(part);
      if (value) handlePart(value, state, tracker);
    }
  }
  const finish = str(candidate?.["finishReason"]);
  if (finish) {
    state.finish = finish;
    output.rawStopReason = finish;
  }
}

function buildHeaders(model: Model, options: StreamOptions): Record<string, string> {
  return mergeHeaders(
    { "content-type": "application/json", accept: "text/event-stream", "user-agent": USER_AGENT },
    authHeaders(options.apiKey, model.authHeader, "x-goog-api-key"),
    model.headers,
    options.headers,
  );
}

export function googleStreamUrl(model: Model): string {
  const id = model.id.replace(/^models\//, "");
  return joinUrl(
    model.baseUrl ?? GOOGLE_BASE_URL,
    `/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`,
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
    const request = buildGoogleRequest(model, context, options);
    tracker.output.thinkingLevel = request.thinkingLevel;
    if (request.providerThinkingLevel !== undefined) {
      tracker.output.providerThinkingLevel = request.providerThinkingLevel;
    }
    const replaced = options.onPayload?.(request.body);
    let response: Response;
    try {
      response = await postJson(googleStreamUrl(model), {
        headers: buildHeaders(model, options),
        body: replaced === undefined ? request.body : replaced,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        onResponse: options.onResponse,
      });
    } catch (error) {
      throw rewriteHttpError(error);
    }
    stream.push({ type: "start", partial: tracker.output });
    const state: StreamState = {
      prose: undefined,
      finish: undefined,
      idSeed: Date.now().toString(36),
    };
    const body = response.body as ReadableStream<Uint8Array>;
    for await (const sse of readSseEvents(body, options.signal)) {
      const data = sse.data.trim();
      if (data === "" || data === "[DONE]") continue;
      let chunk: Json;
      try {
        chunk = obj(JSON.parse(data)) ?? {};
      } catch {
        throw new Error(`Malformed SSE data: ${data.slice(0, 200)}`);
      }
      handleChunk(chunk, state, tracker);
    }
    if (options.signal.aborted) throw new Error("aborted");
    if (state.finish === undefined) throw new Error(STREAM_ENDED_MESSAGE);
    const mapped = mapGoogleFinishReason(state.finish);
    if (mapped.reason === "error") throw new ProviderStopError(mapped.message);
    const reason = mapped.reason === "stop" && tracker.hasToolCalls ? "toolUse" : mapped.reason;
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

export const googleGenerativeAiApi: ApiImplementation<GoogleCompat> = {
  id: "google-generative-ai",
  stream,
  detectCompat: detectGoogleCompat,
};
