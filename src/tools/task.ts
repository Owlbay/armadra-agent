/**
 * `task` 工具：子 Agent 的统一入口（设计 §5.2、D14；第五波 docs/wave5-plan.md §7.3，D13、D23）。
 * [B3 → W5-G]
 *
 * - `agent`：子 Agent 类型（内置 general / explore / plan、`.ama/agents/*.md`）或外部 Agent；缺省
 *   general。描述里列出可用类型（catalog 由 compose-agents.ts 经 `bindTaskAgents` 绑定；没绑定时
 *   只列内置类型）。
 * - `background`：立即返回 taskId，完成后父会话收到 `<task-notification>`；`taskId`：向已有子会话
 *   追加消息（续聊，忽略 agent / tools / model）；`isolation: "worktree"`：在独立 git worktree 里跑。
 * - **parallel**：同一回复里的多个 task 真并行（会话注册表的池限流，缺省 4）；与 sequential 工具
 *   （edit 等）同批时仍按 tool-runner 的规则整批串行。
 * - 深度 ≤ 1：子会话的工具表里保留 task（与父字节一致，缓存前缀可复用），运行时在这里拒绝。
 * - 结果 = 子 Agent 的最终报告（> 50 KB 截头尾、全文落 outputs/，见 agents/result.ts）+ details。
 */

import type { ModelThinkingLevel } from "../ai/types.js";
import { AgentCatalog } from "../agents/catalog.js";
import { TASK_NOTIFICATION_RULE } from "../agents/result.js";
import type { SubagentRequest, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export const MAX_TASK_DEPTH = 1;
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
}

/** 预留（并发上限在会话的任务注册表，见 agent/subagent-registry.ts）。 */
export interface TaskToolOptions {}

const BASE_DESCRIPTION =
  "Delegate to a sub-agent (fresh context; give full instructions). Returns its final report. " +
  "Tasks in one reply run in parallel; writers should use isolation worktree. background: " +
  "returns a taskId now (see task_ctl); taskId: continue that task.";

/** 描述里类型清单的标题（清单本身另有 400 token 预算，见 agents/catalog.ts）。 */
export const TASK_AGENTS_HEADING = "\nAgents:\n";

const catalogs = new WeakMap<object, AgentCatalog>();

/** 组装根把会话的类型目录绑到 task 工具上（描述里的类型清单）。 */
export function bindTaskAgents(tool: ToolDefinition | undefined, catalog: AgentCatalog): void {
  if (tool !== undefined) catalogs.set(tool, catalog);
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
  return request;
}

export function createTaskTool(_options: TaskToolOptions = {}): ToolDefinition<TaskInput> {
  const tool: ToolDefinition<TaskInput> = {
    name: "task",
    label: "Task",
    get description(): string {
      const catalog = catalogs.get(tool) ?? new AgentCatalog();
      return `${BASE_DESCRIPTION}${TASK_AGENTS_HEADING}${catalog.describe()}`;
    },
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        agent: { type: "string", description: "Default general" },
        description: { type: "string" },
        background: { type: "boolean" },
        taskId: { type: "string" },
        isolation: { type: "string", enum: ["none", "worktree"] },
        budgetUsd: { type: "number" },
        tools: { type: "array", items: { type: "string" } },
        model: { type: "string" },
        thinkingLevel: { type: "string", enum: [...THINKING] },
        maxTurns: { type: "integer" },
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
        return fail("Sub-agents are not available here (nested tasks are not allowed).");
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
