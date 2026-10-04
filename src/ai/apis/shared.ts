/**
 * 协议实现共用的流辅助：输出消息骨架、key 预检、内容块跟踪（保证块事件配对）、终止处理。
 *
 * 块事件规则（两条协议与 fake 一致，契约测试逐条断言）：
 * - 每个 `*_start` 恰好对应一个 `*_end`；终止事件之前所有打开的块都会被关闭（出错 / 中止时也
 *   先关块再发 error，消费者不必处理悬空块）；
 * - `toolcall_end` 时 `toolCall.arguments` 一定是对象（容错解析，坏 JSON 退化为 `{}`）；
 * - 流式期间 `arguments` 随增量更新为「到目前为止」的部分对象。
 */

import { AmaError } from "../../errors.js";
import { finalizeUsage, emptyUsage } from "../cost.js";
import type { AssistantEventStreamImpl } from "../event-stream.js";
import { errorText, hasAuthHeader } from "../http.js";
import { parseToolArguments } from "../json-partial.js";
import type {
  AssistantMessage,
  Model,
  StopReason,
  StreamOptions,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
} from "../types.js";

export function createOutput(model: Model): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** 缺 key 时同步抛 `AmaError{code:"no_api_key"}`（§3.1 流契约唯一的同步异常）。 */
export function requireApiKey(model: Model, options: StreamOptions): void {
  if (options.apiKey) return;
  if (model.requiresApiKey === false) return;
  if (hasAuthHeader(model.headers) || hasAuthHeader(options.headers)) return;
  throw new AmaError("no_api_key", `No API key for provider "${model.provider}"`, {
    detail: { provider: model.provider, model: model.id },
  });
}

type OpenBlock =
  | { kind: "text"; block: TextBlock }
  | { kind: "thinking"; block: ThinkingBlock }
  | { kind: "toolCall"; block: ToolCallBlock; json: string };

export class BlockTracker {
  private readonly open = new Map<number, OpenBlock>();

  constructor(
    private readonly stream: AssistantEventStreamImpl,
    readonly output: AssistantMessage,
  ) {}

  isOpen(index: number): boolean {
    return this.open.has(index);
  }

  kindOf(index: number): OpenBlock["kind"] | undefined {
    return this.open.get(index)?.kind;
  }

  startText(text = ""): number {
    const block: TextBlock = { type: "text", text: "" };
    const index = this.push(block);
    this.open.set(index, { kind: "text", block });
    this.stream.push({ type: "text_start", contentIndex: index, partial: this.output });
    if (text) this.appendText(index, text);
    return index;
  }

  appendText(index: number, delta: string): void {
    const entry = this.open.get(index);
    if (entry?.kind !== "text" || delta.length === 0) return;
    entry.block.text += delta;
    this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.output });
  }

  startThinking(thinking = "", signature?: string, redacted = false): number {
    const block: ThinkingBlock = { type: "thinking", thinking: "" };
    if (signature !== undefined) block.thinkingSignature = signature;
    if (redacted) block.redacted = true;
    const index = this.push(block);
    this.open.set(index, { kind: "thinking", block });
    this.stream.push({ type: "thinking_start", contentIndex: index, partial: this.output });
    if (thinking) this.appendThinking(index, thinking);
    return index;
  }

  appendThinking(index: number, delta: string): void {
    const entry = this.open.get(index);
    if (entry?.kind !== "thinking" || delta.length === 0) return;
    entry.block.thinking += delta;
    this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.output });
  }

  appendSignature(index: number, delta: string): void {
    const entry = this.open.get(index);
    if (entry?.kind !== "thinking") return;
    entry.block.thinkingSignature = (entry.block.thinkingSignature ?? "") + delta;
  }

  startToolCall(id: string, name: string, initialArgs?: Record<string, unknown>): number {
    const block: ToolCallBlock = { type: "toolCall", id, name, arguments: initialArgs ?? {} };
    const index = this.push(block);
    this.open.set(index, { kind: "toolCall", block, json: "" });
    this.stream.push({
      type: "toolcall_start",
      contentIndex: index,
      id,
      name,
      partial: this.output,
    });
    return index;
  }

  appendToolArgs(index: number, delta: string): void {
    const entry = this.open.get(index);
    if (entry?.kind !== "toolCall" || delta.length === 0) return;
    entry.json += delta;
    entry.block.arguments = parseToolArguments(entry.json);
    this.stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: this.output });
  }

  toolCallBlock(index: number): ToolCallBlock | undefined {
    const entry = this.open.get(index);
    return entry?.kind === "toolCall" ? entry.block : undefined;
  }

  end(index: number): void {
    const entry = this.open.get(index);
    if (!entry) return;
    this.open.delete(index);
    if (entry.kind === "text") {
      this.stream.push({ type: "text_end", contentIndex: index, partial: this.output });
    } else if (entry.kind === "thinking") {
      this.stream.push({ type: "thinking_end", contentIndex: index, partial: this.output });
    } else {
      if (entry.json.length > 0) entry.block.arguments = parseToolArguments(entry.json);
      this.stream.push({
        type: "toolcall_end",
        contentIndex: index,
        toolCall: entry.block,
        partial: this.output,
      });
    }
  }

  endAll(): void {
    for (const index of [...this.open.keys()].sort((a, b) => a - b)) this.end(index);
  }

  get hasToolCalls(): boolean {
    return this.output.content.some((block) => block.type === "toolCall");
  }

  private push(block: TextBlock | ThinkingBlock | ToolCallBlock): number {
    this.output.content.push(block);
    return this.output.content.length - 1;
  }
}

export const ABORTED_MESSAGE = "Request was aborted";
export const STREAM_ENDED_MESSAGE = "Stream ended before completion";

/** 正常结束：关块、算 usage / cost、发 done。 */
export function finishDone(
  stream: AssistantEventStreamImpl,
  tracker: BlockTracker,
  model: Model,
  reason: "stop" | "length" | "toolUse",
): void {
  tracker.endAll();
  const output = tracker.output;
  output.stopReason = reason;
  finalizeUsage(model, output.usage);
  stream.push({ type: "done", reason, message: output });
}

/** 出错或中止：关块、写 errorMessage、发 error（signal 已中止 → aborted）。 */
export function finishError(
  stream: AssistantEventStreamImpl,
  tracker: BlockTracker,
  model: Model,
  error: unknown,
  signal: AbortSignal,
): void {
  tracker.endAll();
  const output = tracker.output;
  const aborted = signal.aborted;
  output.stopReason = aborted ? "aborted" : "error";
  output.errorMessage = aborted ? ABORTED_MESSAGE : errorText(error);
  finalizeUsage(model, output.usage);
  stream.push({ type: "error", reason: aborted ? "aborted" : "error", message: output });
}

/**
 * 供应商以安全理由拒答（Anthropic `stop_reason: "refusal"`，docs/acp-plan.md D12）：消息照旧以
 * `error` 收尾（TUI / print / 重试的口径不变），`rawStopReason` 记原值；需要区分的消费者（ACP 的
 * `refusal` 停止原因）用 {@link stopReasonOf}。这是 `refusal` 的唯一映射处。[ACP-B]
 */
export function stopReasonOf(
  message: Pick<AssistantMessage, "stopReason" | "rawStopReason">,
): StopReason {
  return message.stopReason === "error" && message.rawStopReason === "refusal"
    ? "refusal"
    : message.stopReason;
}

/** 内部用：可携带供应商原始 stop reason 的错误（content_filter、refusal 等）。 */
export class ProviderStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderStopError";
  }
}
