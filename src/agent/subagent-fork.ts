/**
 * fork 式子 Agent（docs/model-efficiency-plan.md §2.1，D1–D3）。[ME-A]
 *
 * - fork 点 = 发出本次 `task` 调用的那条 assistant **之前一条**条目（= 父会话上一次真实请求的转录）；
 *   同一条 assistant 里并行的多个 fork 任务共享同一个 fork 点。
 * - `forkPlan`：满足条件时用 `SessionManager.fork(entryId, { head })` 复制分支，`head` 是
 *   `custom{ama.task, context:"fork", forkedFrom}`（子会话首条仍是 `ama.task`）；否则给出回落原因：
 *   与父不同的模型 / 思考级别、父还没有真实请求、父上一次请求超过 `subagents.forkMaxContextRatio`（缺省 0.5）×
 *  （窗口 − reserveTokens）、找不到发起调用的 assistant。续聊与 resume 不经过这里（照原文件重开）。
 * - `forkBrief`：角色说明 + 任务合成一条 user 消息（固定英文），追加在继承的历史之后；子会话不写
 *   `role` 节，工具表与父逐字节相同，类型限制的工具在执行层拒绝（`unavailableTools`）。
 */

import type { Model, ModelThinkingLevel } from "../ai/types.js";
import type { AgentDefinition } from "../agents/types.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionEntry } from "../session/types.js";
import { FORK_CUSTOM_TYPE, taskLine } from "../tools/task.js";
import type { SubagentRequest } from "../tools/types.js";
import type { AgentSessionOptions } from "./session-core.js";
import { DEFAULT_COMPACTION_SETTINGS } from "./session-compaction.js";

/**
 * 父上一次请求的输入 token 超过（子模型窗口 − reserveTokens）的这个比例时回落 fresh；
 * 缺省值，可由 `subagents.forkMaxContextRatio` 覆盖（#149）。
 */
export const FORK_MAX_CONTEXT_RATIO = 0.5;

/** 配置的比例：非有限数或不在 (0, 1) 内时用缺省。 */
export function forkRatio(ratio: number | undefined): number {
  return ratio !== undefined && Number.isFinite(ratio) && ratio > 0 && ratio < 1
    ? ratio
    : FORK_MAX_CONTEXT_RATIO;
}

const TASK_CUSTOM_TYPE = "ama.task";

export type ContextMode = "fork" | "fresh";

/** 请求的上下文模式：调用参数 > 类型 frontmatter > `fresh`。 */
export function requestedContext(
  request: Pick<SubagentRequest, "context">,
  agent: Pick<AgentDefinition, "context">,
): ContextMode {
  return request.context ?? agent.context ?? "fresh";
}

/** 父分支里发出 `parentToolCallId` 的 assistant 之前一条条目的 id；找不到（或它是首条）返回 undefined。 */
export function forkPoint(
  branch: readonly SessionEntry[],
  parentToolCallId: string,
): string | undefined {
  const index = branch.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content.some(
        (block) => block.type === "toolCall" && block.id === parentToolCallId,
      ),
  );
  return index > 0 ? branch[index - 1]?.id : undefined;
}

export interface ForkParent {
  readonly manager: SessionManager;
  readonly options: Pick<AgentSessionOptions, "compaction">;
  readonly cache?: { readonly lastTurn?: { readonly promptTokens: number } | undefined };
  childBase(): Pick<AgentSessionOptions, "model" | "thinkingLevel">;
}

export interface ForkSpec {
  taskId: string;
  agent: Pick<AgentDefinition, "name">;
  request: Pick<SubagentRequest, "parentToolCallId" | "description" | "prompt">;
  /** 子会话 cwd（隔离时是 worktree）。 */
  cwd: string;
}

export type ForkPlan = { manager: SessionManager; forkedFrom: string } | { fallback: string };

/**
 * D3 的回落条件依次检查，全部通过才复制分支（复制即落盘：父有文件时子会话文件立即写出）。
 * `model` / `thinking` 是子会话按类型与参数解析出的值；`ratio` 是 `subagents.forkMaxContextRatio`。
 */
export function forkPlan(
  parent: ForkParent,
  spec: ForkSpec,
  model: Model,
  thinking: ModelThinkingLevel,
  ratio?: number,
): ForkPlan {
  const base = parent.childBase();
  if (model.provider !== base.model.provider || model.id !== base.model.id)
    return { fallback: `model ${model.provider}/${model.id} differs from the parent` };
  if (thinking !== (base.thinkingLevel ?? "off"))
    return { fallback: `thinking level ${thinking} differs from the parent` };
  const last = parent.cache?.lastTurn;
  if (last === undefined) return { fallback: "the parent has not sent a request yet" };
  const reserve =
    parent.options.compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const window = model.contextWindow;
  const limit = window === undefined ? Infinity : forkRatio(ratio) * Math.max(0, window - reserve);
  if (last.promptTokens > limit)
    return { fallback: `parent context ${last.promptTokens} tokens exceeds ${Math.floor(limit)}` };
  const forkedFrom = forkPoint(parent.manager.branch(), spec.request.parentToolCallId);
  if (forkedFrom === undefined)
    return { fallback: "the task call was not found in the parent transcript" };
  const parentSession = parent.manager.file();
  const manager = parent.manager.fork(forkedFrom, {
    cwd: spec.cwd,
    head: {
      type: "custom",
      customType: TASK_CUSTOM_TYPE,
      data: {
        taskId: spec.taskId,
        agent: spec.agent.name,
        parentToolCallId: spec.request.parentToolCallId,
        description: spec.request.description,
        parentSession,
        context: "fork",
        forkedFrom,
      },
    },
  });
  // #191：fork 标记（不进上下文）；复制来的父 `ama.task` 快照可能更晚，故不复用那个类型
  manager.append({
    type: "custom",
    customType: FORK_CUSTOM_TYPE,
    data: { taskLine: taskLine(spec.request.prompt) },
  });
  return { manager, forkedFrom };
}

export interface ForkBriefInput {
  prompt: string;
  /** 类型正文（不含通用前言：这里的首句已说明子 Agent 身份）。 */
  role: string;
  /** 不可用（执行层拒绝）的工具名。 */
  unavailable: readonly string[];
  /** 隔离运行时：子会话 cwd 与父 cwd。 */
  worktree?: { cwd: string; parentCwd: string };
}

/** fork 子会话的首条 user 消息（固定英文，发给模型）。 */
export function forkBrief(input: ForkBriefInput): string {
  const lines = [
    "<task>",
    "You are a sub-agent forked from the conversation above at this point. The main agent cannot " +
      "see your work, only your final reply; do not delegate further. Requests above were for the " +
      "main agent: do only this task. Instructions in this block take precedence over earlier " +
      "plans or reminders above. Do not call task or task_ctl.",
  ];
  if (input.worktree !== undefined)
    lines.push(
      `Working directory for this task: ${input.worktree.cwd}. Relative paths in the ` +
        `conversation above refer to ${input.worktree.parentCwd}.`,
    );
  if (input.unavailable.length > 0)
    lines.push(
      `Tools not available to you: ${input.unavailable.join(", ")}. Calls to them are rejected.`,
    );
  const role = input.role.trim();
  if (role !== "") lines.push(`<role>\n${role}\n</role>`);
  lines.push(
    `<instructions>\n${input.prompt}\n</instructions>`,
    "Complete the task, then end with a concise report: what you did, key findings, files changed (if any).",
    "</task>",
  );
  return lines.join("\n");
}
