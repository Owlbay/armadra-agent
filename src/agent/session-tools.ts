/**
 * 会话侧的工具装配（设计 §5.1、§6.3）：tool-runner 的注入项。[B2]
 *
 * 一次工具调用的门禁顺序（§6.3）：schema 校验（tool-runner）→ 命令式 Hook PreToolUse（deny / block
 * 一票否决；updatedInput 替换输入；allow / ask 作为 hookDecision 交给管线）→ 权限管线（B3，注入）→
 * ask 时走审批链（宿主 broker → UI broker → 无人值守 deny；超时 deny）→ 执行 → PostToolUse
 * （additionalContext 追加到结果末尾；block 把结果改为错误）。
 */

import { randomUUID } from "node:crypto";
import type { ToolCallBlock } from "../ai/types.js";
import type { ApprovalDecision, ApprovalRequest, Decision } from "../permissions/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import type { SessionCore } from "./session-core.js";
import { runSingleToolCall, type ToolRunnerOptions } from "./tool-runner.js";
import type { ToolCallGate, ToolCallGateContext } from "./types.js";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

function textOf(content: ToolResult["content"]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
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
      { toolCallId: call.id, toolName: call.name, toolInput: input },
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
  } else if (decision === "ask" && core.options.unattended === true) {
    decision = "deny";
  }

  if (decision === "deny") {
    return { block: true, reason: denyMessage ?? `Permission denied for ${call.name}` };
  }
  if (decision === "ask") {
    const request: ApprovalRequest = {
      requestId: randomUUID(),
      toolName: call.name,
      input,
      reason: approvalReason,
    };
    if (hookReason !== undefined) request.hookReason = hookReason;
    const answer = await requestApproval(core, request, ctx.signal);
    if (answer === "deny") return { block: true, reason: `The user denied ${call.name}` };
    if (answer === "allow_session") permission?.rememberForSession(call.name, input);
  }
  return replaced ? { input } : {};
}

export async function afterToolCall(
  core: SessionCore,
  call: ToolCallBlock,
  result: ToolResult,
): Promise<ToolResult> {
  if (core.options.hooks?.has("PostToolUse", call.name) !== true) return result;
  const outcome = await core.runHook("PostToolUse", {
    toolCallId: call.id,
    toolName: call.name,
    toolInput: call.arguments,
    toolResult: { content: textOf(result.content), isError: result.isError === true },
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
      executeTool: (name, input) => {
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
        return runSingleToolCall(nestedCall, assistant, runner, signal);
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
  const extra: Partial<Record<"sessionFile" | "outputDir" | "spawnSubagent", unknown>> = {};
  if (file !== undefined) extra.sessionFile = file;
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
    beforeToolCall: (call, ctx) => gateToolCall(core, call, ctx),
    afterToolCall: (call, result) => afterToolCall(core, call, result),
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
