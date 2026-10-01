/**
 * 工具执行（设计 §4.4、§6.3）。[B2]
 *
 * 准备阶段**串行**：找工具 → JSON Schema 校验 → `beforeToolCall`（PreToolUse Hook → 权限管线 → broker，
 * 由 AgentSession 注入）→ 若 gate 改了输入则重新校验 → abort 检查。
 * 执行阶段**并行**；任一已准备的工具是 sequential（显式声明，或 write / execute 缺省）则整批串行。
 * `tool_execution_end` 按完成顺序发；toolResult 消息按原序发 `message_start/end`（入转录）。
 * `terminate` 要整批都为真才提前结束。`stopReason: "length"` 且有工具调用 → 整批判失败不执行。
 * abort：未开始的调用直接给 `aborted by user` 错误结果；执行中的工具收到 signal，超过宽限期仍未结束
 * 则不再等待、记 `aborted by user`。结果超 `maxToolResultChars` 截断并把全文写到 `outputDir`。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AssistantMessage,
  ContentBlock,
  ToolCallBlock,
  ToolResultMessage,
} from "../ai/types.js";
import { formatSchemaErrors, validateSchema } from "./schema.js";
import type { SessionEvent, ToolCallGate, ToolCallGateContext } from "./types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types.js";

export const ABORTED_TOOL_TEXT = "aborted by user";
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 30_000;
export const DEFAULT_ABORT_GRACE_MS = 3000;

export type LoopEmit = (event: SessionEvent) => Promise<void>;

export interface ToolRunnerOptions {
  getTool(name: string): ToolDefinition | undefined;
  beforeToolCall(call: ToolCallBlock, ctx: ToolCallGateContext): Promise<ToolCallGate>;
  afterToolCall?(call: ToolCallBlock, result: ToolResult): Promise<ToolResult>;
  createToolContext(
    call: ToolCallBlock,
    signal: AbortSignal,
    onUpdate: (partial: string) => void,
  ): ToolContext;
  maxToolResultChars?: number;
  outputDir?: string | undefined;
  /** abort 后等待工具自行结束的上限。 */
  abortGraceMs?: number;
}

export interface ToolBatchResult {
  messages: ToolResultMessage[];
  terminate: boolean;
}

interface Prepared {
  kind: "prepared";
  call: ToolCallBlock;
  tool: ToolDefinition;
  input: unknown;
}

interface Immediate {
  kind: "immediate";
  call: ToolCallBlock;
  result: ToolResult;
}

export function errorResult(text: string): ToolResult {
  return { content: text, isError: true };
}

export function executionModeOf(tool: ToolDefinition): "sequential" | "parallel" {
  return tool.executionMode ?? (tool.permission === "read" ? "parallel" : "sequential");
}

export function toolResultMessage(call: ToolCallBlock, result: ToolResult): ToolResultMessage {
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError: result.isError === true,
    timestamp: Date.now(),
  };
  if (result.details !== undefined) message.details = result.details;
  return message;
}

export function toolCallsOf(message: AssistantMessage): ToolCallBlock[] {
  return message.content.filter((block): block is ToolCallBlock => block.type === "toolCall");
}

async function prepare(
  call: ToolCallBlock,
  assistant: AssistantMessage,
  options: ToolRunnerOptions,
  signal: AbortSignal,
): Promise<Prepared | Immediate> {
  if (signal.aborted) return { kind: "immediate", call, result: errorResult(ABORTED_TOOL_TEXT) };
  const tool = options.getTool(call.name);
  if (tool === undefined) {
    return { kind: "immediate", call, result: errorResult(`Tool ${call.name} not found`) };
  }
  const invalid = (input: unknown): Immediate | undefined => {
    const errors = validateSchema(tool.parameters, input);
    if (errors.length === 0) return undefined;
    return {
      kind: "immediate",
      call,
      result: errorResult(`Invalid arguments for ${call.name}:\n${formatSchemaErrors(errors)}`),
    };
  };
  const firstCheck = invalid(call.arguments);
  if (firstCheck !== undefined) return firstCheck;
  let input: unknown = call.arguments;
  try {
    const gate = await options.beforeToolCall(call, { signal, assistant, tool });
    if (signal.aborted) return { kind: "immediate", call, result: errorResult(ABORTED_TOOL_TEXT) };
    if (gate.block === true) {
      return {
        kind: "immediate",
        call,
        result: errorResult(gate.reason ?? `Tool ${call.name} was blocked`),
      };
    }
    if (gate.input !== undefined) {
      const recheck = invalid(gate.input);
      if (recheck !== undefined) return recheck;
      input = gate.input;
    }
  } catch (error) {
    return {
      kind: "immediate",
      call,
      result: errorResult(
        signal.aborted ? ABORTED_TOOL_TEXT : `Tool call rejected: ${String(error)}`,
      ),
    };
  }
  return { kind: "prepared", call, tool, input };
}

function resultText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function truncateResult(
  call: ToolCallBlock,
  result: ToolResult,
  options: ToolRunnerOptions,
): ToolResult {
  const limit = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const text = resultText(result.content);
  if (text.length <= limit) return result;
  let where = "全文未保存";
  if (options.outputDir !== undefined) {
    try {
      mkdirSync(options.outputDir, { recursive: true });
      const file = join(options.outputDir, `${call.id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
      writeFileSync(file, text, "utf8");
      where = `全文 ${file}`;
    } catch {
      // 落盘失败只影响提示文字
    }
  }
  const images =
    typeof result.content === "string"
      ? []
      : result.content.filter((block) => block.type === "image");
  const head = `${text.slice(0, limit)}\n\n[输出过长已截断：共 ${text.length} 字符，${where}]`;
  return {
    ...result,
    content: images.length > 0 ? [{ type: "text", text: head }, ...images] : head,
  };
}

async function execute(
  prepared: Prepared,
  options: ToolRunnerOptions,
  signal: AbortSignal,
  emit: LoopEmit,
): Promise<ToolResult> {
  const { call, tool, input } = prepared;
  if (signal.aborted) return errorResult(ABORTED_TOOL_TEXT);
  const updates: Promise<void>[] = [];
  let accepting = true;
  const onUpdate = (partial: string): void => {
    if (!accepting) return;
    updates.push(
      emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, partial }),
    );
  };
  const grace = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  let onAbort: (() => void) | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const abortRace = new Promise<ToolResult>((resolve) => {
    onAbort = () => {
      graceTimer = setTimeout(() => resolve(errorResult(ABORTED_TOOL_TEXT)), grace);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let result: ToolResult;
  try {
    const ctx = options.createToolContext(call, signal, onUpdate);
    const run = tool.execute(input, ctx).then(
      (value) => value,
      (error: unknown) =>
        errorResult(
          signal.aborted
            ? ABORTED_TOOL_TEXT
            : error instanceof Error
              ? error.message
              : String(error),
        ),
    );
    result = await Promise.race([run, abortRace]);
  } catch (error) {
    result = errorResult(error instanceof Error ? error.message : String(error));
  } finally {
    accepting = false;
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
  await Promise.all(updates);
  if (options.afterToolCall !== undefined && !signal.aborted) {
    try {
      result = await options.afterToolCall(call, result);
    } catch (error) {
      result = errorResult(`PostToolUse failed: ${String(error)}`);
    }
  }
  return truncateResult(call, result, options);
}

async function emitEnd(call: ToolCallBlock, result: ToolResult, emit: LoopEmit): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result,
    isError: result.isError === true,
  });
}

async function emitResultMessages(
  finalized: readonly { call: ToolCallBlock; result: ToolResult }[],
  emit: LoopEmit,
): Promise<ToolResultMessage[]> {
  const messages: ToolResultMessage[] = [];
  for (const { call, result } of finalized) {
    const message = toolResultMessage(call, result);
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
    messages.push(message);
  }
  return messages;
}

export async function runToolBatch(
  assistant: AssistantMessage,
  options: ToolRunnerOptions,
  signal: AbortSignal,
  emit: LoopEmit,
): Promise<ToolBatchResult> {
  const calls = toolCallsOf(assistant);
  const preparedList: (Prepared | Immediate)[] = [];
  for (const call of calls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    const prepared = await prepare(call, assistant, options, signal);
    if (prepared.kind === "immediate") await emitEnd(call, prepared.result, emit);
    preparedList.push(prepared);
  }
  const sequential = preparedList.some(
    (item) => item.kind === "prepared" && executionModeOf(item.tool) === "sequential",
  );
  const finalized: { call: ToolCallBlock; result: ToolResult }[] = [];
  if (sequential) {
    for (const item of preparedList) {
      if (item.kind === "immediate") {
        finalized.push({ call: item.call, result: item.result });
        continue;
      }
      const result = await execute(item, options, signal, emit);
      await emitEnd(item.call, result, emit);
      finalized.push({ call: item.call, result });
    }
  } else {
    const results = await Promise.all(
      preparedList.map(async (item) => {
        if (item.kind === "immediate") return { call: item.call, result: item.result };
        const result = await execute(item, options, signal, emit);
        await emitEnd(item.call, result, emit);
        return { call: item.call, result };
      }),
    );
    finalized.push(...results);
  }
  const messages = await emitResultMessages(finalized, emit);
  const terminate =
    finalized.length > 0 && finalized.every(({ result }) => result.terminate === true);
  return { messages, terminate };
}

/** `length` 截断的助手消息：整批判失败，不执行。 */
export async function failTruncatedBatch(
  assistant: AssistantMessage,
  emit: LoopEmit,
): Promise<ToolBatchResult> {
  const finalized = toolCallsOf(assistant).map((call) => ({
    call,
    result: errorResult(
      `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
    ),
  }));
  for (const { call, result } of finalized) {
    await emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    await emitEnd(call, result, emit);
  }
  return { messages: await emitResultMessages(finalized, emit), terminate: false };
}

/** 被中断 / 出错的助手消息里的工具调用：各补一条错误结果（落盘不变式：每个 tool_call 恰有一个 result）。 */
export async function closeDanglingCalls(
  assistant: AssistantMessage,
  emit: LoopEmit,
): Promise<ToolResultMessage[]> {
  const text =
    assistant.stopReason === "aborted" ? ABORTED_TOOL_TEXT : "not executed: the response failed";
  const finalized = toolCallsOf(assistant).map((call) => ({ call, result: errorResult(text) }));
  return emitResultMessages(finalized, emit);
}

/**
 * 单次调用（ToolContext.tools.executeTool 用）：同样经过校验与 beforeToolCall / afterToolCall，
 * 不发事件、不入转录。
 */
export async function runSingleToolCall(
  call: ToolCallBlock,
  assistant: AssistantMessage,
  options: ToolRunnerOptions,
  signal: AbortSignal,
): Promise<ToolResult> {
  const prepared = await prepare(call, assistant, options, signal);
  if (prepared.kind === "immediate") return prepared.result;
  return execute(prepared, options, signal, async () => {});
}
