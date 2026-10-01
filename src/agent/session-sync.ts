/**
 * 会话的落盘与同步辅助（设计 §8、§11.1 第 16 步）。[B2]
 *
 * - `persistMessage`：Agent 的 message_end → 会话条目（LLM 消息 → `message`；custom → `custom_message`）。
 * - `recordModelState`：路径上最近的 model_change / thinking_level_change 与当前不同则补记。
 * - `syncSystemMessage`：目标系统提示 + 工具表与转录重放的状态比对，落全量（首条）或补丁。
 * - `runHookWithEvents`：调 HookDispatcher（公共字段按本会话的 depth / sessionId / sessionFile 覆盖），
 *   逐条发 hook_executed；Hook 自身出错记 warning、按无决策处理。
 */

import type { Model, ModelThinkingLevel } from "../ai/types.js";
import type { HookEvent, HookEventPayload, HookOutcome } from "../hooks/types.js";
import type { AgentMessage, SessionEntryInput } from "../session/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { SessionCore } from "./session-core.js";
import {
  assembleSections,
  currentSystemState,
  definedSections,
  diffSystem,
  toolDecls,
  type SystemPromptInput,
} from "./system-prompt.js";

export function persistMessage(core: SessionCore, message: AgentMessage): void {
  if (message.role === "custom") {
    const input: SessionEntryInput = {
      type: "custom_message",
      customType: message.customType,
      content: message.content,
      display: message.display,
    };
    if (message.details !== undefined) input.details = message.details;
    core.appendEntry(input);
  } else if (message.role !== "compactionSummary" && message.role !== "branchSummary") {
    core.appendEntry({ type: "message", message });
  }
}

export function recordModelState(
  core: SessionCore,
  model: Model,
  thinkingLevel: ModelThinkingLevel,
): void {
  let provider: string | undefined;
  let modelId: string | undefined;
  let thinking: ModelThinkingLevel | undefined;
  for (const entry of core.manager.branch()) {
    if (entry.type === "model_change") {
      provider = entry.provider;
      modelId = entry.modelId;
    } else if (entry.type === "thinking_level_change") thinking = entry.thinkingLevel;
  }
  if (provider !== model.provider || modelId !== model.id) {
    core.appendEntry({ type: "model_change", provider: model.provider, modelId: model.id });
  }
  if (thinking !== thinkingLevel) {
    core.appendEntry({ type: "thinking_level_change", thinkingLevel });
  }
}

export function syncSystemMessage(
  core: SessionCore,
  input: Omit<SystemPromptInput, "tools" | "cwd">,
  tools: readonly ToolDefinition[],
): void {
  recordModelState(core, core.model(), core.thinkingLevel());
  const sections = definedSections(assembleSections({ ...input, tools, cwd: core.cwd }));
  const patch = diffSystem(currentSystemState(core.agent.messages), sections, toolDecls(tools));
  if (patch === undefined) return;
  core.appendEntry({ type: "message", message: patch });
  core.agent.messages.push(patch);
}

export async function runHookWithEvents(
  core: Pick<SessionCore, "options" | "emit" | "log" | "depth" | "manager">,
  event: HookEvent,
  payload: HookEventPayload,
  signal?: AbortSignal,
): Promise<HookOutcome | undefined> {
  const hooks = core.options.hooks;
  if (hooks === undefined || !hooks.has(event, payload.toolName)) return undefined;
  try {
    // 公共字段按本会话覆盖：子 Agent 的 depth / sessionId / sessionFile 不再沿用主会话的。
    const outcome = await hooks.run(event, payload, signal, {
      depth: core.depth,
      sessionId: core.manager.id,
      sessionFile: core.manager.file(),
    });
    for (const result of outcome.results) {
      core.emit({
        type: "hook_executed",
        event: result.event,
        command: result.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    }
    for (const warning of outcome.warnings) core.log("warn", warning);
    return outcome;
  } catch (error) {
    core.log("warn", `${event} hook failed: ${String(error)}`);
    return undefined;
  }
}
