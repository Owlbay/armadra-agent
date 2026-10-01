/**
 * 子 Agent（设计 §5.2 task、D14）：`ToolContext.spawnSubagent` 的实现，供 B3 的 task 工具调用。[B2]
 *
 * - 同进程新会话：独立 JSONL（头的 parentSession 指回父文件；父为内存会话则子也在内存），首条
 *   `custom{customType:"ama.task"}` 记父 toolCallId。
 * - 深度 ≤ 1（子会话 depth 1、无 spawnSubagent）；并发 ≤ 4（排队等待）。
 * - 工具子集缺省 = 父的活动集，总是去掉 task；继承父的权限管线、broker、Hook 与系统提示静态部分。
 * - 父 abort 级联；结果 = 子的最后助手文本 + 用量 + 子会话文件。
 */

import { AmaError } from "../errors.js";
import { SessionManager } from "../session/manager.js";
import type { SubagentRequest, SubagentResult } from "../tools/types.js";
import { ZERO_USAGE } from "./loop.js";
import type { AgentSessionOptions } from "./session-core.js";
import type { SessionEvent, SessionStats } from "./types.js";

export const DEFAULT_SUBAGENT_CONCURRENCY = 4;
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;
export const TASK_CUSTOM_TYPE = "ama.task";

/** 计数信号量。 */
export class SubagentPool {
  private running = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<void> {
    while (this.running >= this.limit) {
      if (signal.aborted) throw new AmaError("aborted", "aborted");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.running++;
  }

  release(): void {
    this.running--;
    this.waiters.shift()?.();
  }
}

export interface SubagentParent {
  readonly options: AgentSessionOptions;
  readonly manager: SessionManager;
  readonly cwd: string;
  readonly depth: number;
  childBase(): Pick<AgentSessionOptions, "model" | "thinkingLevel" | "activeTools" | "system">;
}

export interface ChildSession {
  readonly manager: SessionManager;
  prompt(text: string): Promise<unknown>;
  abort(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  getStats(): SessionStats;
  getLastAssistantText(): string | null;
  dispose(): Promise<void>;
}

function failed(text: string): SubagentResult {
  return { text, usage: { ...ZERO_USAGE }, stopReason: "error", isError: true };
}

export async function runSubagent(
  parent: SubagentParent,
  request: SubagentRequest,
  pool: SubagentPool,
  createChild: (options: AgentSessionOptions) => ChildSession,
): Promise<SubagentResult> {
  if (parent.depth > 0) return failed("subagents cannot spawn subagents");
  await pool.acquire(request.signal);
  try {
    const base = parent.childBase();
    let model = base.model;
    if (request.model !== undefined) {
      const lookup = parent.options.providers.findModel(request.model);
      if (!lookup.ok) return failed(`unknown model ${request.model}`);
      model = lookup.model;
    }
    const parentFile = parent.manager.file();
    const headerOptions = parentFile === undefined ? {} : { parentSession: parentFile };
    const dir = parent.manager.directory();
    const childManager =
      dir === undefined
        ? SessionManager.inMemory(parent.cwd, headerOptions)
        : SessionManager.create(dir, parent.cwd, headerOptions);
    childManager.append({
      type: "custom",
      customType: TASK_CUSTOM_TYPE,
      data: {
        parentToolCallId: request.parentToolCallId,
        description: request.description,
        parentSession: parentFile,
      },
    });
    const available = new Set((parent.options.tools ?? []).map((tool) => tool.name));
    const names = (request.tools ?? base.activeTools ?? [...available]).filter(
      (name) => name !== "task" && available.has(name),
    );
    const child = createChild({
      ...parent.options,
      ...base,
      sessionManager: childManager,
      model,
      thinkingLevel: request.thinkingLevel ?? base.thinkingLevel ?? "off",
      activeTools: names,
      depth: parent.depth + 1,
      maxTurns: request.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      subagents: false,
    });
    const onAbort = (): void => void child.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = child.subscribe((event) => {
      if (event.type === "tool_execution_start") request.onUpdate?.(`[task] ${event.toolName}`);
    });
    let error: string | undefined;
    try {
      if (request.signal.aborted) throw new AmaError("aborted", "aborted");
      await child.prompt(request.prompt);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
    const stats = child.getStats();
    const last = child.manager
      .branch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    const stopReason =
      error !== undefined
        ? "error"
        : last?.type === "message" && last.message.role === "assistant"
          ? last.message.stopReason
          : "stop";
    const result: SubagentResult = {
      text: child.getLastAssistantText() ?? error ?? "",
      usage: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        totalTokens: stats.tokens.total,
      },
      stopReason,
      isError: error !== undefined || stopReason === "error" || stopReason === "aborted",
    };
    const childFile = childManager.file();
    if (childFile !== undefined) result.sessionFile = childFile;
    await child.dispose();
    return result;
  } finally {
    pool.release();
  }
}
