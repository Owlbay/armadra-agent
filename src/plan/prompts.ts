/**
 * plan 模式注入给模型的文本（docs/wave5-plan.md §6.2、D18）。[W5-F]
 *
 * 全部以 `custom_message`（`display:false`）追加在尾部，投影成 user 消息，不碰 system 节与工具表
 * （design §9.1）。文本是给模型看的，用英文；界面文案不在这里。
 */

import type { PlanData } from "../agent/types.js";
import type { AgentMessage } from "../session/types.js";

export const PLAN_MODE_TYPE = "ama.plan_mode";
export const PLAN_MODE_EXIT_TYPE = "ama.plan_mode_exit";
export const PLAN_APPROVED_TYPE = "ama.plan_approved";

/** 完整版（约 400 token）：进入 plan 后首个提示、每第 5 次提醒、压缩之后。 */
export const PLAN_MODE_FULL = `Plan mode is active. You may read and search, run read-only shell commands (ls, cat, grep, rg, find, git status/log/show/diff, …) and start read-only subagents with task. Do not modify files, run builds or tests, or change any state; write/execute tools are refused in this mode.

How to work:
1. Explore first. Answer questions from the repository yourself instead of asking the user; ask only about decisions that the code cannot settle.
2. When you are ready, write the plan as one block, with the tags on their own lines:

<proposed_plan>
# <title>

## Background
1–3 sentences: the goal and the key facts you found.

## Steps
- [ ] S1 <action> (files: path/a.ts)
- [ ] S2 <action> [depends: S1] [agent: <name>]

## Verification
- <command or check>

## Assumptions and risks
- <defaults you chose for open questions>
</proposed_plan>

Rules for the plan:
- Make it specific enough that someone else could carry it out without making further decisions. List the key files; describe a repeated change once.
- Always include a Verification section.
- At most one <proposed_plan> block per reply; to revise, rewrite the whole block.
- Do not ask "is this OK?" in prose: the plan block itself is shown to the user for approval.
- If the user asks you to make changes while plan mode is active, treat it as a request to plan how to make them.
- Do not use the todo tool to record the plan; the task list is created from the steps when the plan is approved.`;

/** 简版：两次完整版之间每 5 个提示一次。 */
export const PLAN_MODE_BRIEF =
  "Plan mode is still active: read-only exploration only. Finish with a <proposed_plan> block (Background, Steps as - [ ] S1 …, Verification, Assumptions and risks).";

/** 手动退出 plan（没有获批的计划）。 */
export const PLAN_MODE_EXIT =
  "Plan mode has ended. The read-only restrictions no longer apply; the current permission mode decides what you may do.";

/** 获批交接时开启新回合的用户消息（之后紧跟 `ama.plan_approved`）。 */
export const PLAN_APPROVED_PROMPT = "The plan is approved. Go ahead.";

/**
 * 提醒节奏：plan 模式下第 n 个提示（从 1 起）。每 5 个提示提醒一次（第 1、6、11 … 个），
 * 第 1、6、11 … 次提醒里每第 5 次用完整版（即第 1、26、51 … 个提示）。
 */
export function reminderKind(promptIndex: number): "full" | "brief" | undefined {
  if (promptIndex < 1 || (promptIndex - 1) % 5 !== 0) return undefined;
  const reminder = (promptIndex - 1) / 5;
  return reminder % 5 === 0 ? "full" : "brief";
}

/** 交接消息：计划已批准 + plan 模式结束 + 计划全文 + 文件路径 + 按 todo 推进。 */
export function planApprovedText(plan: Pick<PlanData, "markdown" | "filePath" | "steps">): string {
  const lines = [
    "The user approved the plan below. Plan mode has ended: you may now edit files and run commands as the current permission mode allows.",
  ];
  if (plan.steps.length > 0) {
    lines.push(
      "The todo list has been created from the plan steps (the first step is in progress). Work through it in order and mark each step with todo update as soon as it is done.",
    );
  }
  if (plan.filePath !== undefined) lines.push(`Plan file: ${plan.filePath}`);
  lines.push("", "<approved_plan>", plan.markdown, "</approved_plan>");
  return lines.join("\n");
}

/** 「批准，在新上下文执行」：新会话的首条用户消息。 */
export function freshContextPrompt(
  plan: Pick<PlanData, "markdown" | "filePath" | "steps">,
): string {
  const lines = [
    "Carry out the approved plan below. It was written in an earlier session that you cannot see; the plan is self-contained.",
  ];
  if (plan.steps.length > 0)
    lines.push("Track progress with the todo tool: mark each step with todo update when done.");
  if (plan.filePath !== undefined) lines.push(`Plan file: ${plan.filePath}`);
  lines.push("", "<approved_plan>", plan.markdown, "</approved_plan>");
  return lines.join("\n");
}

export function planMessage(customType: string, content: string): AgentMessage {
  return { role: "custom", customType, content, display: false, timestamp: Date.now() };
}
