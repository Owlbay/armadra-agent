/**
 * `task` 工具：同进程子 Agent（设计 §5.2、D14）。[B3]
 *
 * 子会话由 `ctx.spawnSubagent`（B2 的 AgentSession 提供）创建：独立 JSONL、继承权限模式与 broker、
 * 审批串到父。本工具负责：
 * - 深度 ≤ 1：`ctx.depth ≥ 1` 或无 `spawnSubagent` → 错误（子 Agent 里没有 task）；
 * - 并发 ≤ 4：每个工具实例一个信号量，超出排队；排队中父 abort → 立即返回 aborted；
 * - 工具子集：`tools` 里去掉 `task`（缺省交给 spawnSubagent = 父活动集去掉 task）；
 * - 父 abort 级联：把 `ctx.signal` 传给子；
 * - 结果 = 子的最后助手文本 + `details{ sessionFile, usage, stopReason }`。
 */

import type { ModelThinkingLevel } from "../ai/types.js";
import type { SubagentRequest, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export const MAX_TASK_DEPTH = 1;
export const MAX_TASK_CONCURRENCY = 4;
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
  description?: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  maxTurns?: number;
}

export interface TaskToolOptions {
  maxConcurrency?: number;
}

/** 简单计数信号量；等待可被 abort。 */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error("aborted");
    if (this.active < this.limit) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("aborted"));
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.active++;
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

export function buildSubagentRequest(input: TaskInput, ctx: ToolContext): SubagentRequest | string {
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    return "prompt must be a non-empty string";
  }
  const maxTurns = input.maxTurns ?? DEFAULT_TASK_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) return "maxTurns must be an integer ≥ 1";
  if (input.thinkingLevel !== undefined && !THINKING.includes(input.thinkingLevel)) {
    return `thinkingLevel must be one of ${THINKING.join(", ")}`;
  }
  const request: SubagentRequest = {
    prompt: input.prompt,
    maxTurns,
    parentToolCallId: ctx.toolCallId,
    signal: ctx.signal,
    onUpdate: (partial) => ctx.onUpdate(partial),
  };
  if (input.description !== undefined) request.description = input.description;
  if (input.tools !== undefined) request.tools = input.tools.filter((t) => t !== "task");
  if (input.model !== undefined) request.model = input.model;
  if (input.thinkingLevel !== undefined) request.thinkingLevel = input.thinkingLevel;
  return request;
}

export function createTaskTool(options: TaskToolOptions = {}): ToolDefinition<TaskInput> {
  const semaphore = new Semaphore(options.maxConcurrency ?? MAX_TASK_CONCURRENCY);
  return {
    name: "task",
    label: "Task",
    description:
      "Delegate a self-contained subtask to a sub-agent with its own context. It cannot see this " +
      "conversation, so the prompt must include everything it needs. Returns the sub-agent's " +
      "final answer. Sub-agents cannot start further tasks.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Complete instructions for the sub-agent" },
        description: { type: "string", description: "Short label shown to the user" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Tool names to allow (default: all of yours except task)",
        },
        model: { type: "string", description: "provider/model-id (default: same as yours)" },
        thinkingLevel: {
          type: "string",
          enum: [...THINKING],
          description: "Thinking level (default: same as yours)",
        },
        maxTurns: {
          type: "integer",
          description: `Maximum turns (default ${DEFAULT_TASK_MAX_TURNS})`,
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    permission: "execute",
    executionMode: "sequential",
    promptSnippet: "task: delegate a self-contained subtask to a sub-agent",
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.depth >= MAX_TASK_DEPTH || ctx.spawnSubagent === undefined) {
        return fail("Sub-agents are not available here (nested tasks are not allowed).");
      }
      const request = buildSubagentRequest(input, ctx);
      if (typeof request === "string") return fail(request);
      let release: () => void;
      try {
        release = await semaphore.acquire(ctx.signal);
      } catch {
        return fail("aborted by user");
      }
      try {
        const result = await ctx.spawnSubagent(request);
        const details = {
          ...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
          usage: result.usage,
          stopReason: result.stopReason,
        };
        if (ctx.signal.aborted) return { content: "aborted by user", isError: true, details };
        const text = result.text.trim() === "" ? "(the sub-agent returned no text)" : result.text;
        return { content: text, isError: result.isError, details };
      } catch (err) {
        if (ctx.signal.aborted) return fail("aborted by user");
        return fail(`Sub-agent failed: ${(err as Error).message}`);
      } finally {
        release();
      }
    },
  };
}
