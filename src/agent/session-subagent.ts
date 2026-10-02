/**
 * 子 Agent（设计 §5.2 task、D14）：`ToolContext.spawnSubagent` 的实现，供 B3 的 task 工具调用。[B2]
 *
 * - 同进程新会话：独立 JSONL（头的 parentSession 指回父文件；父为内存会话则子也在内存），首条
 *   `custom{customType:"ama.task"}` 记父 toolCallId。
 * - 深度 ≤ 1（子会话 depth 1、无 spawnSubagent）；并发 ≤ 4（排队等待）。
 * - 工具子集缺省 = 父的活动集，总是去掉 task；继承父的权限管线、Hook 与系统提示静态部分；
 *   broker 包一层，请求带 `context{depth, parentToolCallId}`，审批事件转发到父会话。
 * - 父 abort 级联；结果 = 子的最后助手文本 + 用量 + 子会话文件。
 * - [W3-C1b] 子会话有自己的缓存控制器（统计独立、未命中不进父链，`warmSubagents` 为 false 时
 *   不保温）；结果带 `cache{hitRate, reBilledTokens}`，并汇总进父会话的「子任务」统计。
 */

import type { CheckpointHooks } from "../checkpoints/types.js";
import { AmaError } from "../errors.js";
import type { ApprovalBroker, ApprovalRequestContext } from "../permissions/types.js";
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
  /** 子会话的审批事件转发给父会话的订阅者（RPC 客户端 / TUI 据此作答）。 */
  emit?(event: SessionEvent): void;
  /** [RW-B] 父会话的检查点钩子：子会话的编辑记到父会话当前回合。 */
  checkpointHooks?(): CheckpointHooks | undefined;
  /** [W3-C1b] 父会话的缓存控制器：汇总子会话的命中与重计费。 */
  readonly cache?: {
    addSubagent(tokens: { cacheRead: number; prompt: number }, reBilledTokens: number): void;
  };
}

/** 子会话的 broker：请求带上发起方上下文（对话框标 `[task]`），其余原样交给父链。 */
function brokersForChild(
  brokers: AgentSessionOptions["brokers"],
  context: ApprovalRequestContext,
): ApprovalBroker[] {
  return (brokers ?? []).map((broker) => ({
    ask: (request, signal) => broker.ask({ ...request, context }, signal),
  }));
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
    const checkpointHooks = parent.checkpointHooks?.();
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
      brokers: brokersForChild(parent.options.brokers, {
        depth: parent.depth + 1,
        parentToolCallId: request.parentToolCallId,
      }),
      depth: parent.depth + 1,
      maxTurns: request.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      subagents: false,
      ...(checkpointHooks === undefined ? {} : { checkpointHooks }),
    });
    const onAbort = (): void => void child.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = child.subscribe((event) => {
      if (event.type === "tool_execution_start") request.onUpdate?.(`[task] ${event.toolName}`);
      else if (event.type === "permission_request" || event.type === "permission_resolved")
        parent.emit?.(event);
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
    const cache = stats.cache;
    if (cache !== undefined) {
      result.cache = { reBilledTokens: cache.reBilledTokens };
      if (cache.hitRate !== undefined) result.cache.hitRate = cache.hitRate;
      // 不报缓存的子会话不进命中率分母（同父会话口径）
      const reported = cache.reporting === "reported";
      const { input, cacheRead, cacheWrite } = stats.tokens;
      parent.cache?.addSubagent(
        reported
          ? { cacheRead, prompt: input + cacheRead + cacheWrite }
          : { cacheRead: 0, prompt: 0 },
        cache.reBilledTokens,
      );
    }
    const childFile = childManager.file();
    if (childFile !== undefined) result.sessionFile = childFile;
    await child.dispose();
    return result;
  } finally {
    pool.release();
  }
}
