/**
 * `task` 工具：子 Agent 的统一入口（设计 §5.2、D14；第五波 docs/wave5-plan.md §7.3，D13、D23）。
 * [B3 → W5-G]
 *
 * - `agent`：子 Agent 类型（内置 general / explore / plan、`.ama/agents/*.md`）或外部 Agent；缺省
 *   general。描述里列出可用类型（catalog 由 compose-agents.ts 经 `bindTaskAgents` 绑定；没绑定时
 *   只列内置类型）。
 * - [W7-B1] 缺省前台 / 后台由 `subagents.background` 决定（交互 / RPC / ACP 后台，`-p` 前台），描述随之
 *   二选一（`bindTaskBackground`）；前台任务可被 `background()` 转后台，工具立即以固定文案返回。
 * - `background`：立即返回 taskId，完成后父会话收到 `<task-notification>`；`taskId`：向已有子会话
 *   追加消息（续聊，忽略 agent / tools / model）；`isolation: "worktree"`：在独立 git worktree 里跑。
 * - **parallel**：同一回复里的多个 task 真并行（会话注册表的池限流，缺省 4）；与 sequential 工具
 *   （edit 等）同批时仍按 tool-runner 的规则整批串行。
 * - 深度 ≤ 1：子会话的工具表里保留 task（与父字节一致，缓存前缀可复用），运行时在这里拒绝。
 * - [ME-A] `context: "fork"`：子会话继承本会话已完成的回合（同模型、同前缀）；`details.context` 是实际
 *   模式（不满足条件时回落 `fresh`）。
 * - 结果 = 子 Agent 的最终报告（> 50 KB 截头尾、全文落 outputs/，见 agents/result.ts）+ details。
 */

import type { ModelThinkingLevel } from "../ai/types.js";
import { AgentCatalog } from "../agents/catalog.js";
import { TASK_NOTIFICATION_RULE } from "../agents/result.js";
import type { SubagentRequest, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export const MAX_TASK_DEPTH = 1;
/** fork 子会话首条 custom 条目里 <task> 指令首行摘要的上限（字符）。 */
const TASK_LINE_MAX = 120;

/** <task> 指令首个非空行，超长截断（#191：fork 子会话被拒时提醒模型回到子任务）。 */
export function taskLine(prompt: string): string {
  const line =
    prompt
      .split("\n")
      .find((text) => text.trim() !== "")
      ?.trim() ?? "";
  return line.length > TASK_LINE_MAX ? `${line.slice(0, TASK_LINE_MAX - 1)}…` : line;
}

/** fork 子会话的标记条目（custom，不进上下文）：`{ taskLine }`。 */
export const FORK_CUSTOM_TYPE = "ama.fork";

/**
 * 子会话里 task / task_ctl 的拒绝文案（固定英文）。#191：fork 子会话（有 `ama.fork` 条目）说明身份并
 * 附 <task> 首行；其它情况用 `fallback`（fresh 按深度拒绝的原文案）。
 */
export function nestedTaskRejection(ctx: ToolContext, tool: string, fallback: string): string {
  const mark = ctx.session.lastCustom(FORK_CUSTOM_TYPE) as { taskLine?: unknown } | undefined;
  if (mark === undefined || mark === null) return fallback;
  const line = typeof mark.taskLine === "string" ? mark.taskLine : "";
  return (
    `${tool} rejected: you are a sub-agent forked from the main conversation and cannot start ` +
    "or manage sub-agents. Do not call task or task_ctl again; complete the sub-task in your " +
    "<task> block yourself with your other tools, then end with your report." +
    (line !== "" ? ` Your task begins: "${line}"` : "")
  );
}
export const DEFAULT_TASK_MAX_TURNS = 30;
const THINKING: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export interface TaskInput {
  prompt: string;
  agent?: string;
  description?: string;
  background?: boolean;
  taskId?: string;
  isolation?: "none" | "worktree";
  budgetUsd?: number;
  tools?: string[];
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  maxTurns?: number;
  context?: "fork" | "fresh";
}

/** 预留（并发上限在会话的任务注册表，见 agent/subagent-registry.ts）。 */
export interface TaskToolOptions {}

/**
 * [ME-A] 两版描述共用的开头：fresh / fork 两种上下文。default+task 与 codemode-only 的预算余量都只有
 * 几十 token，加 `context` 参数时整段改写、字符数基本不增（`agent` 参数的「Default general」也去掉，
 * 清单里 general 已标 default）。
 */
export const TASK_CONTEXT_LEAD =
  "Delegate to a sub-agent (fresh context: give full instructions; context fork: inherits " +
  "this conversation).";

/** 缺省前台（`-p`、`subagents.background: never`）时的描述。 */
export const FOREGROUND_DESCRIPTION =
  `${TASK_CONTEXT_LEAD} Returns its final report. Parallel in one reply; writers use isolation ` +
  "worktree. background: returns a taskId (see task_ctl); taskId: continue it.";

/** [W7-B1] 缺省后台（交互 / RPC / ACP，docs/agents-concurrency-plan.md §2.6）时的描述。 */
export const BACKGROUND_DESCRIPTION =
  `${TASK_CONTEXT_LEAD} Runs in the background by default: returns a taskId; a ` +
  "<task-notification> follows; keep working. background:false waits for the result. " +
  "taskId: continue it. Parallel in one reply; writers use isolation worktree.";

/** 描述里类型清单的标题（清单本身另有 400 token 预算，见 agents/catalog.ts）。 */
export const TASK_AGENTS_HEADING = "\nAgents:\n";

const catalogs = new WeakMap<object, AgentCatalog>();
const backgrounds = new WeakMap<object, boolean>();

/** 组装根把会话的类型目录绑到 task 工具上（描述里的类型清单）。 */
export function bindTaskAgents(tool: ToolDefinition | undefined, catalog: AgentCatalog): void {
  if (tool !== undefined) catalogs.set(tool, catalog);
}

/**
 * [W7-B1] 组装根把本进程的缺省前台 / 后台（`subagents.background` 按运行模式解析后）绑到 task 工具：
 * 决定描述用哪一版。会话内不变（缓存前缀稳定）；没绑定按缺省前台。
 */
export function bindTaskBackground(tool: ToolDefinition | undefined, background: boolean): void {
  if (tool !== undefined) backgrounds.set(tool, background);
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

export function buildSubagentRequest(input: TaskInput, ctx: ToolContext): SubagentRequest | string {
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    return "prompt must be a non-empty string";
  }
  if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1))
    return "maxTurns must be an integer ≥ 1";
  if (input.thinkingLevel !== undefined && !THINKING.includes(input.thinkingLevel)) {
    return `thinkingLevel must be one of ${THINKING.join(", ")}`;
  }
  if (input.isolation !== undefined && input.isolation !== "none" && input.isolation !== "worktree")
    return 'isolation must be "none" or "worktree"';
  if (input.budgetUsd !== undefined && !(input.budgetUsd > 0)) return "budgetUsd must be > 0";
  if (input.context !== undefined && input.context !== "fork" && input.context !== "fresh")
    return 'context must be "fork" or "fresh"';
  const request: SubagentRequest = {
    prompt: input.prompt,
    parentToolCallId: ctx.toolCallId,
    signal: ctx.signal,
    onUpdate: (partial) => ctx.onUpdate(partial),
  };
  if (input.maxTurns !== undefined) request.maxTurns = input.maxTurns;
  if (input.description !== undefined) request.description = input.description;
  if (input.background !== undefined) request.background = input.background;
  if (input.taskId !== undefined) {
    request.taskId = input.taskId;
    return request;
  }
  if (input.agent !== undefined) request.agent = input.agent;
  if (input.isolation !== undefined) request.isolation = input.isolation;
  if (input.budgetUsd !== undefined) request.budgetUsd = input.budgetUsd;
  if (input.tools !== undefined) request.tools = input.tools.filter((t) => t !== "task");
  if (input.model !== undefined) request.model = input.model;
  if (input.thinkingLevel !== undefined) request.thinkingLevel = input.thinkingLevel;
  if (input.context !== undefined) request.context = input.context;
  return request;
}

export function createTaskTool(_options: TaskToolOptions = {}): ToolDefinition<TaskInput> {
  const tool: ToolDefinition<TaskInput> = {
    name: "task",
    label: "Task",
    get description(): string {
      const catalog = catalogs.get(tool) ?? new AgentCatalog();
      const base = backgrounds.get(tool) === true ? BACKGROUND_DESCRIPTION : FOREGROUND_DESCRIPTION;
      return `${base}${TASK_AGENTS_HEADING}${catalog.describe()}`;
    },
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        agent: { type: "string" },
        description: { type: "string" },
        background: { type: "boolean" },
        taskId: { type: "string" },
        isolation: { type: "string", enum: ["none", "worktree"] },
        budgetUsd: { type: "number" },
        tools: { type: "array", items: { type: "string" } },
        model: { type: "string" },
        thinkingLevel: { type: "string", enum: [...THINKING] },
        maxTurns: { type: "integer" },
        context: { type: "string", enum: ["fork", "fresh"] },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    permission: "execute",
    executionMode: "parallel",
    promptSnippet: "task: run a sub-agent",
    promptGuidelines: [TASK_NOTIFICATION_RULE],
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.depth >= MAX_TASK_DEPTH || ctx.spawnSubagent === undefined) {
        return fail(
          nestedTaskRejection(
            ctx,
            "task",
            "Sub-agents are not available here (nested tasks are not allowed).",
          ),
        );
      }
      const request = buildSubagentRequest(input, ctx);
      if (typeof request === "string") return fail(request);
      if (ctx.signal.aborted) return fail("aborted by user");
      try {
        const result = await ctx.spawnSubagent(request);
        const details = {
          ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
          ...(result.outputFile !== undefined ? { outputFile: result.outputFile } : {}),
          ...(result.context !== undefined ? { context: result.context } : {}),
          usage: result.usage,
          stopReason: result.stopReason,
        };
        if (ctx.signal.aborted && result.status !== "running")
          return { content: "aborted by user", isError: true, details };
        const text = result.text.trim() === "" ? "(the sub-agent returned no text)" : result.text;
        const head = result.taskId !== undefined ? `[task ${result.taskId}] ` : "";
        return { content: `${head}${text}`, isError: result.isError, details };
      } catch (err) {
        if (ctx.signal.aborted) return fail("aborted by user");
        return fail(`Sub-agent failed: ${(err as Error).message}`);
      }
    },
  };
  return tool;
}
