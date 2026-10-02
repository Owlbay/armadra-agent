/**
 * 工具执行（设计 §4.4、§6.3）。[B2]
 *
 * 准备阶段**串行**：找工具 → JSON Schema 校验 → `beforeToolCall`（PreToolUse Hook → 权限管线 → broker，
 * 由 AgentSession 注入）→ 若 gate 改了输入则重新校验 → abort 检查。
 * 执行阶段**并行**；任一已准备的工具是 sequential（显式声明，或 write / execute 缺省）则整批串行。
 * `tool_execution_end` 按完成顺序发；toolResult 消息按原序发 `message_start/end`（入转录）。
 * `terminate` 要整批都为真才提前结束。`stopReason: "length"` 且有工具调用 → 整批判失败不执行。
 * abort：未开始的调用直接给 `aborted by user` 错误结果；执行中的工具收到 signal，超过宽限期仍未结束
 * 则不再等待、记 `aborted by user`。结果超 `maxToolResultChars` 截断并把全文写到 `outputDir`：
 * [W5-H2] 保留头 70% + 尾 30%，中间 `[… N 字符已省略，全文 <path>]`（tools/truncate.ts）。
 *
 * 嵌套调用（`ToolContext.tools.executeTool`，codemode 脚本里的 `tools.*`）走 `runSingleToolCall`：
 * 同一套校验与门禁，按**全部未禁用工具**查找（codemode only 模式下活动集只有 codemode），
 * 发带 `parentToolCallId` 的 `tool_execution_start / update / end`（不入转录），门禁与 PostToolUse
 * 拿到 `parent`（Hook 输入的 `viaCodemode / parentToolCallId`）；结果给脚本而不是模型，截断上限放宽到
 * `NESTED_MAX_RESULT_CHARS`。
 *
 * [W5-H2] 重复调用检测（loop-guard.ts）只看顶层调用：同 run 同名同参第 3、4 次在结果末尾追加提醒，
 * 第 5 次不执行、给错误结果，整批返回 `stop: "repeated_tool_call"`（循环据此结束 run）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AssistantMessage,
  ContentBlock,
  ToolCallBlock,
  ToolResultMessage,
} from "../ai/types.js";
import {
  REPEATED_TOOL_CALL,
  guardFor,
  loopReminderText,
  loopStopText,
  type LoopVerdict,
} from "./loop-guard.js";
import { formatSchemaErrors, validateSchema } from "./schema.js";
import type { NestedCallInfo, SessionEvent, ToolCallGate, ToolCallGateContext } from "./types.js";
import type { AutoDecision } from "../permissions/types.js";
import { CODEMODE_TOOL } from "../tools/presets.js";
import { executionModeOf } from "../tools/registry.js";
import { truncateMiddle } from "../tools/truncate.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types.js";

export const ABORTED_TOOL_TEXT = "aborted by user";
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 30_000;
export const DEFAULT_ABORT_GRACE_MS = 3000;
/** 嵌套调用结果的截断上限（给脚本，不进上下文）。 */
export const NESTED_MAX_RESULT_CHARS = 1024 * 1024;

export type LoopEmit = (event: SessionEvent) => Promise<void>;

/** 嵌套调用：由 `runSingleToolCall` 的调用方提供。 */
export interface NestedCall {
  parent: NestedCallInfo;
  /** 嵌套调用的 tool_execution_* 事件出口（事件已带 parentToolCallId）。 */
  emit: LoopEmit;
}

export interface ToolRunnerOptions {
  getTool(name: string): ToolDefinition | undefined;
  beforeToolCall(call: ToolCallBlock, ctx: ToolCallGateContext): Promise<ToolCallGate>;
  afterToolCall?(
    call: ToolCallBlock,
    result: ToolResult,
    ctx?: { parent?: NestedCallInfo },
  ): Promise<ToolResult>;
  /** 嵌套调用的工具查找（全部未禁用工具）；缺省同 getTool。 */
  getNestedTool?(name: string): ToolDefinition | undefined;
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
  /** [W5-H2] 结束本 run 的原因（重复调用检测到 5 次：`repeated_tool_call`）。 */
  stop?: string;
}

/** 门禁给出的 auto 判定，随 tool_execution_end 发出（按调用对象记，调用结束后随之回收）。 */
const autoDecisions = new WeakMap<ToolCallBlock, AutoDecision>();
/** 门禁拒绝（gate.block）而没有执行的调用：tool_execution_end 带 `denied`。 */
const deniedCalls = new WeakSet<ToolCallBlock>();

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

/**
 * 找不到工具的错误文本。codemode `only` 下模型常直接调用 `read` 等（它们只在脚本里可用）：
 * 这时告诉模型正确写法。
 */
function notFoundText(name: string, options: ToolRunnerOptions): string {
  if (options.getNestedTool?.(name) !== undefined && options.getTool(CODEMODE_TOOL) !== undefined) {
    return `Tool ${name} is only callable inside a codemode script: tools.${name}({...})`;
  }
  return `Tool ${name} not found`;
}

async function prepare(
  call: ToolCallBlock,
  assistant: AssistantMessage,
  options: ToolRunnerOptions,
  signal: AbortSignal,
  parent?: NestedCallInfo,
): Promise<Prepared | Immediate> {
  if (signal.aborted) return { kind: "immediate", call, result: errorResult(ABORTED_TOOL_TEXT) };
  const tool =
    parent !== undefined && options.getNestedTool !== undefined
      ? options.getNestedTool(call.name)
      : options.getTool(call.name);
  if (tool === undefined) {
    return { kind: "immediate", call, result: errorResult(notFoundText(call.name, options)) };
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
    const gateContext: ToolCallGateContext =
      parent === undefined ? { signal, assistant, tool } : { signal, assistant, tool, parent };
    const gate = await options.beforeToolCall(call, gateContext);
    if (gate.autoDecision !== undefined) autoDecisions.set(call, gate.autoDecision);
    if (signal.aborted) return { kind: "immediate", call, result: errorResult(ABORTED_TOOL_TEXT) };
    if (gate.block === true) {
      deniedCalls.add(call);
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
  nested = false,
): ToolResult {
  const limit = nested
    ? NESTED_MAX_RESULT_CHARS
    : (options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS);
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
  const { content } = truncateMiddle(
    text,
    limit,
    (omitted) => `[… ${omitted} 字符已省略（输出过长已截断：共 ${text.length} 字符，${where}）]`,
  );
  return {
    ...result,
    content: images.length > 0 ? [{ type: "text", text: content }, ...images] : content,
  };
}

async function execute(
  prepared: Prepared,
  options: ToolRunnerOptions,
  signal: AbortSignal,
  emit: LoopEmit,
  parent?: NestedCallInfo,
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
      result =
        parent === undefined
          ? await options.afterToolCall(call, result)
          : await options.afterToolCall(call, result, { parent });
    } catch (error) {
      result = errorResult(`PostToolUse failed: ${String(error)}`);
    }
  }
  return truncateResult(call, result, options, parent !== undefined);
}

async function emitEnd(call: ToolCallBlock, result: ToolResult, emit: LoopEmit): Promise<void> {
  const event: Extract<SessionEvent, { type: "tool_execution_end" }> = {
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result,
    isError: result.isError === true,
  };
  const auto = autoDecisions.get(call);
  if (auto !== undefined) event.autoDecision = auto;
  if (deniedCalls.has(call)) event.denied = true;
  await emit(event);
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
  const guard = guardFor(signal);
  const verdicts = new Map<ToolCallBlock, LoopVerdict>();
  let stop: string | undefined;
  for (const call of calls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    const verdict = guard.observe(call, options.getTool(call.name));
    verdicts.set(call, verdict);
    if (verdict === "stop") {
      stop = REPEATED_TOOL_CALL;
      const result = errorResult(loopStopText(call.name, guard.count(call)));
      await emitEnd(call, result, emit);
      preparedList.push({ kind: "immediate", call, result });
      continue;
    }
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
  appendBatchSuffix(finalized, signal, stop);
  for (const item of finalized) {
    if (verdicts.get(item.call) === "remind")
      item.result = withReminder(
        item.result,
        loopReminderText(item.call.name, guard.count(item.call)),
      );
  }
  const messages = await emitResultMessages(finalized, emit);
  const terminate =
    finalized.length > 0 && finalized.every(({ result }) => result.terminate === true);
  return stop === undefined ? { messages, terminate } : { messages, terminate, stop };
}

/**
 * [W5-H2] 本 run 的「批次尾部提醒」来源（reminders.ts 在 agent_start 时以 run 的 signal 登记）：
 * 每个工具批次结束时取一次，非空就追加在本批**最后一条**结果末尾——run 进行中的提醒（todo 复述、
 * 文件改动、上下文用量、预算、后台命令退出）由此进上下文，只改新结果、不碰前缀。
 */
const batchSuffixSources = new WeakMap<AbortSignal, () => string | undefined>();

export function setBatchSuffixSource(signal: AbortSignal, source: () => string | undefined): void {
  batchSuffixSources.set(signal, source);
}

function appendBatchSuffix(
  finalized: { call: ToolCallBlock; result: ToolResult }[],
  signal: AbortSignal,
  stop: string | undefined,
): void {
  const last = finalized.at(-1);
  if (last === undefined || stop !== undefined || signal.aborted) return;
  let suffix: string | undefined;
  try {
    suffix = batchSuffixSources.get(signal)?.();
  } catch {
    suffix = undefined;
  }
  if (suffix !== undefined && suffix !== "") last.result = withReminder(last.result, suffix);
}

/** 在结果末尾追加一段文本（字符串结果拼接，块数组追加 text 块）。 */
function withReminder(result: ToolResult, text: string): ToolResult {
  const content =
    typeof result.content === "string"
      ? `${result.content}\n\n${text}`
      : [...result.content, { type: "text" as const, text }];
  return { ...result, content };
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
 * 不入转录。给了 `nested` 时按全部工具查找、发带 `parentToolCallId` 的 tool_execution_* 事件、
 * 门禁拿到 `parent`；不给则不发事件（与旧行为相同）。
 */
export async function runSingleToolCall(
  call: ToolCallBlock,
  assistant: AssistantMessage,
  options: ToolRunnerOptions,
  signal: AbortSignal,
  nested?: NestedCall,
): Promise<ToolResult> {
  if (nested === undefined) {
    const prepared = await prepare(call, assistant, options, signal);
    if (prepared.kind === "immediate") return prepared.result;
    return execute(prepared, options, signal, async () => {});
  }
  const parentToolCallId = nested.parent.toolCallId;
  const emit: LoopEmit = (event) =>
    nested.emit(
      event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end"
        ? { ...event, parentToolCallId }
        : event,
    );
  await emit({
    type: "tool_execution_start",
    toolCallId: call.id,
    toolName: call.name,
    args: call.arguments,
  });
  const prepared = await prepare(call, assistant, options, signal, nested.parent);
  const result =
    prepared.kind === "immediate"
      ? prepared.result
      : await execute(prepared, options, signal, emit, nested.parent);
  await emitEnd(call, result, emit);
  return result;
}
