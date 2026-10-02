/**
 * 会话侧的工具装配（设计 §5.1、§6.3）：tool-runner 的注入项。[B2]
 *
 * 一次工具调用的门禁顺序（§6.3）：schema 校验（tool-runner）→ 命令式 Hook PreToolUse（deny / block
 * 一票否决；updatedInput 替换输入；allow / ask 作为 hookDecision 交给管线）→ 权限管线（B3，注入）→
 * ask 时走审批链（宿主 broker → UI broker → 无人值守 deny；超时 deny）→ 执行 → PostToolUse
 * （additionalContext 追加到结果末尾；block 把结果改为错误）。
 *
 * （W3-B9a-2）ask 时请求带 `context{depth, readFiles}` 与执行前预览 `preview`（只读、有上限，
 * 见 permissions/preview.ts）；预览出错或为空则缺省，不影响审批。`permission_request` 事件同样带
 * `preview`，RPC 客户端可直接显示。
 */

import { randomUUID } from "node:crypto";
import type { ToolCallBlock } from "../ai/types.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../permissions/broker.js";
import { previewAction } from "../permissions/preview.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import type {
  ActionPreview,
  ApprovalDecision,
  ApprovalRequest,
  AutoDecision,
  Decision,
  PermissionRequestContext,
} from "../permissions/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { classifierRequest } from "./session-classifier.js";
import type { SessionCore } from "./session-core.js";
import { runSingleToolCall, type ToolRunnerOptions } from "./tool-runner.js";
import type { NestedCallInfo, ToolCallGate, ToolCallGateContext } from "./types.js";

/** 外层是这个工具时，嵌套调用的 Hook 输入带 `viaCodemode: true`。 */
const CODEMODE_TOOL_NAME = "codemode";

function textOf(content: ToolResult["content"]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * [W5-EG] `permission_request.context`：子 Agent（depth、taskId）与外部 Agent（origin）的来源，供
 * RPC 客户端与对话框标注。ama 子会话的请求没带 taskId 时取子会话首条 `custom{ama.task}`；
 * 主会话自己的调用返回 undefined（事件形状不变）。
 */
function requestContext(
  core: SessionCore,
  request: ApprovalRequest,
): PermissionRequestContext | undefined {
  const source = request.context;
  const depth = Math.max(source?.depth ?? 0, core.depth);
  let taskId = source?.taskId;
  if (taskId === undefined && core.depth > 0) {
    const head = core.manager
      .branch()
      .find((e) => e.type === "custom" && e.customType === "ama.task");
    const data = head?.type === "custom" ? (head.data as { taskId?: unknown }) : undefined;
    if (typeof data?.taskId === "string") taskId = data.taskId;
  }
  const origin = source?.origin;
  const toolCallId = source?.toolCallId;
  if (depth === 0 && taskId === undefined && origin === undefined && toolCallId === undefined)
    return undefined;
  const context: PermissionRequestContext = {};
  if (depth > 0) context.depth = depth;
  if (taskId !== undefined) context.taskId = taskId;
  if (origin !== undefined) context.origin = origin;
  if (toolCallId !== undefined) context.toolCallId = toolCallId;
  return context;
}

/** 审批链：依次问每个 broker，第一个给出决定的为准；全部弃权 → deny。 */
export async function requestApproval(
  core: SessionCore,
  request: ApprovalRequest,
  signal: AbortSignal,
): Promise<ApprovalDecision> {
  const timeoutMs = core.options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const event: Parameters<SessionCore["emit"]>[0] = {
    type: "permission_request",
    requestId: request.requestId,
    toolName: request.toolName,
    input: request.input,
    reason: request.reason,
    timeoutMs,
  };
  if (request.hookReason !== undefined) event.hookReason = request.hookReason;
  if (request.preview !== undefined) event.preview = request.preview;
  if (request.autoDecision !== undefined) event.autoDecision = request.autoDecision;
  const context = requestContext(core, request);
  if (context !== undefined) event.context = context;
  core.emit(event);
  void core.runHook("Notification", {
    notification: { kind: "approval", message: `approval requested for ${request.toolName}` },
  });
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let decision: ApprovalDecision = "deny";
  try {
    for (const broker of core.options.brokers ?? []) {
      if (controller.signal.aborted) break;
      const answer = await Promise.race([
        broker.ask(request, controller.signal).catch(() => undefined),
        new Promise<undefined>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
        ),
      ]);
      if (answer !== undefined) {
        decision = answer;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) decision = "deny"; // run 被中断：即使 broker 已放行也不执行
  core.emit({ type: "permission_resolved", requestId: request.requestId, decision });
  return decision;
}

/** 嵌套调用时 Hook 输入的两个字段（设计 §5.5）；模型直接发起的调用不带。 */
function nestedFields(parent: NestedCallInfo | undefined): {
  viaCodemode?: boolean;
  parentToolCallId?: string;
} {
  if (parent === undefined) return {};
  return parent.viaCodemode
    ? { viaCodemode: true, parentToolCallId: parent.toolCallId }
    : { parentToolCallId: parent.toolCallId };
}

/** 审批请求的执行前预览；出错或没有可显示的内容时 undefined（预览永不阻塞审批）。 */
function safePreview(core: SessionCore, request: ApprovalRequest): ActionPreview | undefined {
  try {
    const preview = previewAction(request, { cwd: core.cwd });
    return preview.lines.length > 0 ? preview : undefined;
  } catch (err) {
    core.log(
      "warn",
      `approval preview failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export async function gateToolCall(
  core: SessionCore,
  call: ToolCallBlock,
  ctx: ToolCallGateContext,
): Promise<ToolCallGate> {
  const tool = ctx.tool;
  if (tool === undefined) return { block: true, reason: `Tool ${call.name} not found` };
  let input: unknown = call.arguments;
  let replaced = false;
  let hookDecision: Decision | undefined;
  let hookReason: string | undefined;

  if (core.options.hooks?.has("PreToolUse", call.name) === true) {
    const outcome = await core.runHook(
      "PreToolUse",
      { toolCallId: call.id, toolName: call.name, toolInput: input, ...nestedFields(ctx.parent) },
      ctx.signal,
    );
    if (outcome !== undefined) {
      if (outcome.stop) core.requestStop(outcome.reason);
      if (outcome.decision === "deny" || outcome.decision === "block") {
        return { block: true, reason: outcome.reason ?? `Blocked by PreToolUse hook` };
      }
      if (outcome.hasUpdatedInput) {
        input = outcome.updatedInput;
        replaced = true;
      }
      if (outcome.decision === "allow" || outcome.decision === "ask") {
        hookDecision = outcome.decision;
        hookReason = outcome.reason;
      }
    }
  }

  const permission = core.options.permission;
  let decision: Decision = hookDecision === "ask" ? "ask" : "allow";
  let approvalReason: ApprovalRequest["reason"] = "hook";
  let denyMessage: string | undefined;
  let autoDecision: AutoDecision | undefined;
  if (permission !== undefined) {
    const checkInput: Parameters<typeof permission.check>[0] = {
      toolName: call.name,
      permission: tool.permission,
      input,
      unattended: core.options.unattended === true,
    };
    if (hookDecision !== undefined) checkInput.hookDecision = hookDecision;
    if (hookReason !== undefined) checkInput.hookReason = hookReason;
    const verdict = permission.check(checkInput);
    decision = verdict.decision;
    approvalReason = verdict.approvalReason ?? "mode";
    denyMessage = verdict.message;
    autoDecision = verdict.auto;
    if (verdict.classify === true) {
      // auto 第 3 层：规则层与静态判定都没决定，问一次独立的模型分类器（只能变 allow）
      const judged = await core
        .autoClassifier()
        .classify(
          classifierRequest(
            core,
            call.name,
            input,
            permission.projectRoot,
            verdict.sandboxed === true && permission instanceof PermissionPipeline
              ? { network: permission.bashSandbox?.network ?? "deny" }
              : undefined,
          ),
          ctx.signal,
        );
      autoDecision = { layer: "classifier", decision: judged.decision, reason: judged.reason };
      if (judged.cached) autoDecision.cached = true;
      if (judged.decision === "allow") decision = "allow";
    }
    if (autoDecision !== undefined) permission.recordAutoDecision?.(call.name, input, autoDecision);
  } else if (decision === "ask" && core.options.unattended === true) {
    decision = "deny";
  }

  const withAuto = (gate: ToolCallGate): ToolCallGate =>
    autoDecision === undefined ? gate : { ...gate, autoDecision };
  if (decision === "deny") {
    return withAuto({ block: true, reason: denyMessage ?? `Permission denied for ${call.name}` });
  }
  if (decision === "ask") {
    const request: ApprovalRequest = {
      requestId: randomUUID(),
      toolName: call.name,
      input,
      reason: approvalReason,
      context: { depth: core.depth, readFiles: core.readFiles, toolCallId: call.id },
    };
    if (hookReason !== undefined) request.hookReason = hookReason;
    if (autoDecision !== undefined) request.autoDecision = autoDecision;
    const preview = safePreview(core, request);
    if (preview !== undefined) request.preview = preview;
    const answer = await requestApproval(core, request, ctx.signal);
    if (answer === "deny") return withAuto({ block: true, reason: `The user denied ${call.name}` });
    if (answer === "allow_session") permission?.rememberForSession(call.name, input);
  }
  return withAuto(replaced ? { input } : {});
}

export async function afterToolCall(
  core: SessionCore,
  call: ToolCallBlock,
  result: ToolResult,
  parent?: NestedCallInfo,
): Promise<ToolResult> {
  if (core.options.hooks?.has("PostToolUse", call.name) !== true) return result;
  const outcome = await core.runHook("PostToolUse", {
    toolCallId: call.id,
    toolName: call.name,
    toolInput: call.arguments,
    toolResult: { content: textOf(result.content), isError: result.isError === true },
    ...nestedFields(parent),
  });
  if (outcome === undefined) return result;
  if (outcome.stop) core.requestStop(outcome.reason);
  let next = result;
  const extras: string[] = [];
  if (outcome.decision === "block" || outcome.decision === "deny") {
    next = { ...next, isError: true };
    extras.push(outcome.reason ?? "Blocked by PostToolUse hook");
  }
  if (outcome.additionalContext !== undefined && outcome.additionalContext !== "") {
    extras.push(outcome.additionalContext);
  }
  if (extras.length === 0) return next;
  const suffix = `\n\n${extras.join("\n\n")}`;
  const content =
    typeof next.content === "string"
      ? next.content + suffix
      : [...next.content, { type: "text" as const, text: suffix.trimStart() }];
  return { ...next, content };
}

export function createToolContext(
  core: SessionCore,
  runner: ToolRunnerOptions,
  call: ToolCallBlock,
  signal: AbortSignal,
  onUpdate: (partial: string) => void,
): ToolContext {
  const model = core.model();
  let nested = 0;
  const ctx: ToolContext = {
    toolCallId: call.id,
    cwd: core.cwd,
    sessionId: core.manager.id,
    signal,
    depth: core.depth,
    model: { provider: model.provider, id: model.id },
    thinkingLevel: core.thinkingLevel(),
    onUpdate,
    readFiles: core.readFiles,
    markRead: (path) => {
      core.readFiles.add(path);
    },
    tools: {
      executeTool: (name, input, options) => {
        nested++;
        const nestedCall: ToolCallBlock = {
          type: "toolCall",
          id: `${call.id}_n${nested}`,
          name,
          arguments:
            typeof input === "object" && input !== null && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
        };
        const assistant = core.agent.messages.findLast((message) => message.role === "assistant");
        if (assistant === undefined || assistant.role !== "assistant") {
          return Promise.resolve({ content: "no active assistant message", isError: true });
        }
        const nestedSignal =
          options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]);
        return runSingleToolCall(nestedCall, assistant, runner, nestedSignal, {
          parent: { toolCallId: call.id, viaCodemode: call.name === CODEMODE_TOOL_NAME },
          emit: async (event) => core.emit(event),
        });
      },
    },
    session: {
      appendCustom: (customType, data) => {
        core.appendEntry({ type: "custom", customType, data });
      },
      lastCustom: (customType) => {
        const branch = core.manager.branch();
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry?.type === "custom" && entry.customType === customType) return entry.data;
        }
        return undefined;
      },
    },
    log: (level, message) => core.log(level, message),
  };
  const file = core.manager.file();
  const outputDir = core.outputDir();
  const extra: Partial<
    Record<"sessionFile" | "outputDir" | "spawnSubagent" | "checkpoint", unknown>
  > = {};
  if (file !== undefined) extra.sessionFile = file;
  // [RW-B] 检查点钩子：主会话有后端时为它，task 子会话为父会话的（记到父会话当前回合）
  const checkpoint = core.checkpointHooks?.();
  if (checkpoint !== undefined) extra.checkpoint = checkpoint;
  if (outputDir !== undefined) extra.outputDir = outputDir;
  if (core.depth === 0 && core.options.subagents !== false) {
    extra.spawnSubagent = (request: Parameters<NonNullable<ToolContext["spawnSubagent"]>>[0]) =>
      core.spawnSubagent(request);
  }
  return Object.assign(ctx, extra);
}

export function createToolRunnerOptions(core: SessionCore): ToolRunnerOptions {
  const runner: ToolRunnerOptions = {
    getTool: (name) => core.activeTool(name),
    getNestedTool: (name) => core.tool(name),
    beforeToolCall: (call, ctx) => gateToolCall(core, call, ctx),
    afterToolCall: (call, result, ctx) => afterToolCall(core, call, result, ctx?.parent),
    createToolContext: (call, signal, onUpdate) =>
      createToolContext(core, runner, call, signal, onUpdate),
    get outputDir() {
      return core.outputDir();
    },
  };
  if (core.options.maxToolResultChars !== undefined) {
    runner.maxToolResultChars = core.options.maxToolResultChars;
  }
  if (core.options.abortGraceMs !== undefined) runner.abortGraceMs = core.options.abortGraceMs;
  return runner;
}
