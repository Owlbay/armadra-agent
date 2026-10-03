/**
 * 内置子 Agent 类型（docs/wave5-plan.md §7.2，D22–D23）。[W5-G]
 *
 * 三个类型都用父会话的活动工具集（工具表与父字节一致，缓存前缀可复用）；只读靠权限层：
 * `explore` / `plan` 的 `permissionMode: "plan"` 让子会话用 plan 模式的管线，写类工具与非只读 bash
 * 被拒绝且不弹审批（session-subagent.ts）。正文是追加到子会话系统提示末尾的角色说明（`role` 节）。
 */

import type { AgentDefinition } from "./types.js";

/** 所有 ama 子会话共有的角色说明（类型正文追加在它后面）。 */
export const SUBAGENT_ROLE_PREAMBLE =
  "You are a sub-agent: the main agent delegated one task to you. It cannot see your work, only " +
  "your final reply. Complete the task directly; do not delegate further. End with a concise " +
  "report: what you did, key findings, and files changed (if any).";

function builtin(
  name: string,
  description: string,
  prompt: string,
  permissionMode: "plan" | "inherit",
): AgentDefinition {
  return {
    name,
    description,
    permissionMode,
    model: "inherit",
    maxTurns: 30,
    isolation: "none",
    runner: "ama",
    prompt,
    source: "builtin",
  };
}

export const BUILTIN_AGENTS: readonly AgentDefinition[] = Object.freeze([
  builtin(
    "general",
    "General-purpose sub-agent (default): researches and changes code like you do.",
    "",
    "inherit",
  ),
  builtin(
    "explore",
    "Read-only search: locates files, symbols and code paths; returns paths with line numbers.",
    "Locate, do not review. Return file paths with line numbers and short notes on what is " +
      "where. State the search scope you covered. You cannot modify files; bash runs read-only " +
      "commands only.",
    "plan",
  ),
  builtin(
    "plan",
    "Read-only planner: returns a step-by-step plan with key files and trade-offs.",
    "Produce a step-by-step implementation plan: key files to change, the order of steps, and " +
      "trade-offs or risks. Do not modify files; you are read-only.",
    "plan",
  ),
]);

export const DEFAULT_AGENT = "general";

/** 子会话系统提示 `role` 节：通用说明 + 类型正文。 */
export function agentRole(agent: Pick<AgentDefinition, "prompt">): string {
  const own = agent.prompt.trim();
  return own === "" ? SUBAGENT_ROLE_PREAMBLE : `${SUBAGENT_ROLE_PREAMBLE}\n\n${own}`;
}
