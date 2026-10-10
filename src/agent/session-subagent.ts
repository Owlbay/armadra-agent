/**
 * 子 Agent（设计 §5.2 task、D14；第五波 docs/wave5-plan.md §7，D22–D24）：`ToolContext.spawnSubagent`
 * 的实现与 ama 自己的 runner（`AmaRunner`）。[B2 → W5-G]
 *
 * - `runSubagent`：交给会话的任务注册表（subagent-registry.ts）——类型解析、并发池、前台 / 后台、
 *   续聊、结果上限、事件都在那里；这里只提供「起一个 ama 子会话」的 runner。
 * - 子会话：同进程新会话，独立 JSONL（头的 parentSession 指回父文件；父为内存会话则子也在内存），
 *   首条 `custom{ama.task}` 记父 toolCallId 与 taskId；深度 ≤ 1（depth 1、无 spawnSubagent）。
 * - **工具表与父字节一致**（D23）：活动集 = 父活动集，`task` / `task_ctl` 保留在表里、运行时按深度
 *   拒绝，子会话首请求能命中父的 tools + system 前缀；角色说明进系统提示末位 `role` 节。只有类型
 *   声明了 `tools` / `disallowed-tools`（或调用参数给了 `tools`）时工具表才不同。
 * - 只读类型（`permission-mode: plan`）：子会话用一条 plan 模式的权限管线（规则同父），ask 一律转
 *   deny——写类工具与识别不了的 bash 被拒且不弹审批；`inherit` 共用父的管线（不会比父宽）。
 * - 轮数耗尽且最后停在工具结果上：以 `maxTurns: 1` 再跑一轮要最终报告（只靠提示、不发 `toolChoice`，
 *   [ME-A] D13 请求选项不变才能命中缓存；仍调用工具则结果回落为「没有文本」），状态 `max_turns`。
 * - [ME-A] `context: "fork"`（D1–D3，subagent-fork.ts）：子会话复制父分支到发起调用的 assistant 之前，
 *   不写 `role` 节、工具表与父相同、类型限制改由 `unavailableTools` 在执行层拒绝；任务以 `<task>` 消息
 *   追加在继承的历史之后。不满足条件时回落 fresh（记 info 日志），结果的 `context` 标实际模式。
 * - broker 包一层，请求带 `context{depth, parentToolCallId, taskId}`，审批事件转发到父会话；
 *   [RW-B] 父的检查点钩子（worktree 里运行时不记）；[W3-C1b] 子会话命中与重计费汇总进父。
 * - [W6-A] 句柄外露 `observe` / `entries`（子 Agent 视图跟随）与 `message`（视图里直接发的消息，
 *   `origin: "direct"`：运行中 followUp，空闲开新一轮）；一轮收尾时才入队、没赶上的 followUp 接着再跑一轮。
 */

import type { CheckpointHooks } from "../checkpoints/types.js";
import { AmaError } from "../errors.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import type {
  ApprovalBroker,
  ApprovalRequestContext,
  PermissionPipelineApi,
} from "../permissions/types.js";
import { SessionManager } from "../session/manager.js";
import type { AgentMessage } from "../session/types.js";
import type { MessageOrigin } from "../ai/types.js";
import type {
  RunnerHandle,
  SubagentRequest,
  SubagentResult,
  SubagentRunRequest,
  SubagentRunner,
} from "../tools/types.js";
import { agentRole } from "../agents/builtin.js";
import { ZERO_USAGE } from "./loop.js";
import type { RequestRecord } from "../ai/cache/types.js";
import type { AgentSessionOptions } from "./session-core.js";
import { forkBrief, forkPlan, requestedContext, type ContextMode } from "./subagent-fork.js";
import {
  DEFAULT_SUBAGENT_CONCURRENCY,
  SubagentPool,
  TASK_CUSTOM_TYPE,
  subagentRegistryFor,
  type AmaRunnerSpec,
  type RegistryHost,
  type TaskHandle,
} from "./subagent-registry.js";
import type { SessionEvent, SessionStats } from "./types.js";

export { DEFAULT_SUBAGENT_CONCURRENCY, SubagentPool, TASK_CUSTOM_TYPE };
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;
/** 子会话里保留在工具表、运行时拒绝的名字（深度 ≤ 1）。 */
export const PARENT_ONLY_TOOLS: readonly string[] = ["task", "task_ctl"];

export const FINAL_REPORT_PROMPT =
  "You have reached the turn limit for this task. Do not call any tools. Reply now with your " +
  "final report: what you did, key findings, and what is left unfinished.";

export interface SubagentParent extends RegistryHost {
  readonly options: AgentSessionOptions;
  readonly manager: SessionManager;
  readonly cwd: string;
  readonly depth: number;
  childBase(): Pick<AgentSessionOptions, "model" | "thinkingLevel" | "activeTools" | "system">;
  /** 子会话的审批事件转发给父会话的订阅者（RPC 客户端 / TUI 据此作答）。 */
  emit(event: SessionEvent): void;
  /** [RW-B] 父会话的检查点钩子：子会话的编辑记到父会话当前回合。 */
  checkpointHooks?(): CheckpointHooks | undefined;
  /** [W3-C1b] 父会话的缓存控制器：汇总子会话的命中与重计费。 */
  readonly cache?: {
    addSubagent(tokens: { cacheRead: number; prompt: number }, reBilledTokens: number): void;
    /** [ME-A] 父会话上一次真实请求（fork 的前提与上下文比例）。 */
    readonly lastTurn?: RequestRecord | undefined;
  };
}

/** 子会话的 broker：请求带上发起方上下文（对话框标 `[task:<agent>]`），其余原样交给父链。 */
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
  readonly messages: readonly AgentMessage[];
  prompt(text: string, options?: { origin?: MessageOrigin; interrupt?: boolean }): Promise<unknown>;
  /** [W6-A] 视图里直接发的消息（运行中排到回合结束）。 */
  followUp?(text: string, options?: { origin?: MessageOrigin }): Promise<unknown>;
  /** [W6-A] 取出排队消息（一轮收尾时才入队、没被消费的）。 */
  clearQueue?(): { steering: string[]; followUp: string[] };
  abort(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  getStats(): SessionStats;
  getLastAssistantText(): string | null;
  dispose(): Promise<void>;
}

/**
 * 只读子会话的权限管线：plan 模式、规则同父；ask 一律转 deny（只读类型不弹审批）。
 * 父管线不是 `PermissionPipeline`（宿主 / SDK 自带实现）时退化为「只放行 read 类」。
 */
export function readOnlyPermission(
  parent: PermissionPipelineApi | undefined,
  cwd: string,
): PermissionPipelineApi {
  const base = parent instanceof PermissionPipeline ? parent : undefined;
  const inner = new PermissionPipeline({
    mode: "plan",
    rules: parent?.rules ?? [],
    cwd: base?.cwd ?? cwd,
    ...(parent?.projectRoot === undefined ? {} : { projectRoot: parent.projectRoot }),
    // 沿用父的 plan.bash（deny 更严时照样 deny；ask 由下面统一转 deny）
    ...(base === undefined ? {} : { planBash: base.planBash }),
  });
  const denied =
    "Read-only sub-agent: this call is not allowed (it would modify files or run a non-read-only command).";
  return {
    get mode() {
      return "plan" as const;
    },
    setMode: () => undefined,
    get rules() {
      return inner.rules;
    },
    check: (input) => {
      const verdict = inner.check(input);
      return verdict.decision === "ask"
        ? { ...verdict, decision: "deny", message: verdict.message ?? denied }
        : verdict;
    },
    rememberForSession: () => undefined,
    ...(parent?.projectRoot === undefined ? {} : { projectRoot: parent.projectRoot }),
  };
}

function failed(text: string): SubagentResult {
  return { text, usage: { ...ZERO_USAGE }, stopReason: "error", isError: true, status: "failed" };
}

export async function runSubagent(
  parent: SubagentParent,
  request: SubagentRequest,
  _pool: SubagentPool,
  createChild: (options: AgentSessionOptions) => ChildSession,
): Promise<SubagentResult> {
  if (parent.depth > 0) return failed("subagents cannot spawn subagents");
  const registry = subagentRegistryFor(parent);
  return registry.run(request, (spec) => createAmaRunner(parent, spec, createChild));
}

/** 活动集：缺省 = 父活动集（含 task / task_ctl，工具表对齐）；白名单 / 黑名单时按名过滤。 */
function childToolNames(
  parent: SubagentParent,
  spec: AmaRunnerSpec,
  base: readonly string[] | undefined,
): string[] {
  const available = new Set((parent.options.tools ?? []).map((tool) => tool.name));
  const all = [...(base ?? available)].filter((name) => available.has(name));
  const allow = spec.request.tools ?? spec.agent.tools;
  if (allow !== undefined)
    return allow.filter((name) => available.has(name) && !PARENT_ONLY_TOOLS.includes(name));
  const deny = spec.agent.disallowedTools;
  if (deny !== undefined)
    return all.filter((name) => !deny.includes(name) && !PARENT_ONLY_TOOLS.includes(name));
  return all;
}

/** ama 自己的子会话 runner（同进程）。 */
export function createAmaRunner(
  parent: SubagentParent,
  spec: AmaRunnerSpec,
  createChild: (options: AgentSessionOptions) => ChildSession,
): SubagentRunner {
  return {
    id: "ama",
    start: (request) => startAmaChild(parent, spec, createChild, request),
  };
}

function childManager(parent: SubagentParent, spec: AmaRunnerSpec): SessionManager {
  if (spec.resumeFile !== undefined) return SessionManager.open(spec.resumeFile);
  const parentFile = parent.manager.file();
  const header = parentFile === undefined ? {} : { parentSession: parentFile };
  const dir = parent.manager.directory();
  const manager =
    dir === undefined
      ? SessionManager.inMemory(spec.cwd, header)
      : SessionManager.create(dir, spec.cwd, header);
  manager.append({
    type: "custom",
    customType: TASK_CUSTOM_TYPE,
    data: {
      taskId: spec.taskId,
      agent: spec.agent.name,
      parentToolCallId: spec.request.parentToolCallId,
      description: spec.request.description,
      parentSession: parentFile,
    },
  });
  // 立即落盘：subagent_start 带上子会话文件，续聊 / resume 靠它重开
  if (dir !== undefined) manager.flush();
  return manager;
}

async function startAmaChild(
  parent: SubagentParent,
  spec: AmaRunnerSpec,
  createChild: (options: AgentSessionOptions) => ChildSession,
  run: SubagentRunRequest,
): Promise<TaskHandle> {
  const base = parent.childBase();
  let model = base.model;
  if (spec.modelRef !== undefined) {
    const lookup = parent.options.providers.findModel(spec.modelRef);
    if (!lookup.ok) throw new AmaError("model_not_found", `unknown model ${spec.modelRef}`);
    model = lookup.model;
  }
  const thinkingLevel =
    spec.request.thinkingLevel ?? spec.agent.thinking ?? base.thinkingLevel ?? "off";
  const wanted =
    spec.resumeFile === undefined && requestedContext(spec.request, spec.agent) === "fork";
  // #149：比例来自 `subagents.forkMaxContextRatio`（注册表环境里的整段配置）
  const ratio = subagentRegistryFor(parent).env.modelConfig?.subagents?.forkMaxContextRatio;
  const plan = wanted ? forkPlan(parent, spec, model, thinkingLevel, ratio) : undefined;
  if (plan !== undefined && "fallback" in plan)
    parent.log("info", `task ${spec.taskId}: fork falls back to fresh (${plan.fallback})`);
  const forked = plan !== undefined && "manager" in plan ? plan.manager : undefined;
  const mode: ContextMode | undefined = !wanted ? undefined : forked ? "fork" : "fresh";
  const manager = forked ?? childManager(parent, spec);
  const checkpointHooks = spec.isolated ? undefined : parent.checkpointHooks?.();
  const maxTurns = spec.request.maxTurns ?? spec.agent.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS;
  const allowed = childToolNames(parent, spec, base.activeTools);
  // fork：工具表 = 父活动集（前缀不变），类型限制的工具在执行层拒绝
  const inherited = base.activeTools ?? (parent.options.tools ?? []).map((tool) => tool.name);
  const unavailable = inherited.filter(
    (name) => !allowed.includes(name) && !PARENT_ONLY_TOOLS.includes(name),
  );
  // #150：<task> 里也列出按深度拒绝的 task / task_ctl（执行层的拒绝文案不变）
  const briefUnavailable = [
    ...unavailable,
    ...PARENT_ONLY_TOOLS.filter((name) => inherited.includes(name)),
  ];
  const options: AgentSessionOptions = {
    ...parent.options,
    ...base,
    // fork：系统提示与父相同（base.system，不加 role 节）
    ...(forked === undefined ? { system: { ...base.system, role: agentRole(spec.agent) } } : {}),
    sessionManager: manager,
    model,
    thinkingLevel,
    ...(forked === undefined ? { activeTools: allowed } : {}),
    brokers: brokersForChild(parent.options.brokers, {
      depth: parent.depth + 1,
      parentToolCallId: spec.request.parentToolCallId,
      taskId: spec.taskId,
    }),
    depth: parent.depth + 1,
    maxTurns,
    subagents: false,
  };
  if (forked !== undefined && unavailable.length > 0)
    options.unavailableTools = [...(parent.options.unavailableTools ?? []), ...unavailable];
  delete options.checkpointHooks;
  if (checkpointHooks !== undefined) options.checkpointHooks = checkpointHooks;
  if (spec.agent.permissionMode === "plan")
    options.permission = readOnlyPermission(parent.options.permission, spec.cwd);
  const child = createChild(options);

  let turns = 0;
  let toolUse = false;
  const unsubscribe = child.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.parentToolCallId === undefined)
      run.onEvent({ type: "tool", toolName: event.toolName, status: "started" });
    else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      run.onEvent({ type: "text", delta: event.assistantMessageEvent.delta });
    else if (event.type === "turn_end") {
      turns++;
      toolUse = event.toolResults.length > 0;
      const { input, output, cacheRead, cacheWrite, total } = child.getStats().tokens;
      run.onEvent({
        type: "usage",
        usage: { input, output, cacheRead, cacheWrite, totalTokens: total },
      });
      run.onEvent({ type: "turn", turn: turns });
    } else if (event.type === "permission_request" || event.type === "permission_resolved")
      parent.emit(event);
  });
  if (mode !== undefined) run.onEvent({ type: "context", mode });
  const onAbort = (): void => void child.abort();
  run.signal.addEventListener("abort", onAbort, { once: true });
  let billed = { cacheRead: 0, prompt: 0, reBilled: 0 };

  let active = false;
  /** 视图里「打断并发送」开的回合（runOnce 等它们跑完再收尾）。 */
  const forced: Promise<unknown>[] = [];
  const runOnce = async (prompt: string, origin?: MessageOrigin): Promise<SubagentResult> => {
    const startTurns = turns;
    let error: string | undefined;
    active = true;
    try {
      if (run.signal.aborted) throw new AmaError("aborted", "aborted");
      await child.prompt(prompt, origin === undefined ? {} : { origin });
      // [W6-A] 收尾阶段才入队的 followUp（只可能来自视图）留在队列里：接着再跑一轮
      for (;;) {
        while (forced.length > 0) await forced.shift();
        const left = child.clearQueue?.().followUp ?? [];
        if (left.length === 0 || run.signal.aborted) break;
        await child.prompt(left.join("\n\n"), { origin: "direct" });
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    active = false;
    const exhausted =
      error === undefined && !run.signal.aborted && turns - startTurns >= maxTurns && toolUse;
    if (exhausted) {
      options.maxTurns = 1;
      try {
        await child.prompt(FINAL_REPORT_PROMPT);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      } finally {
        options.maxTurns = maxTurns;
      }
    }
    const result = collect(child, error, exhausted, run.signal.aborted);
    if (mode !== undefined) result.context = mode;
    billed = addCache(parent, child.getStats(), billed);
    const file = manager.file();
    if (file !== undefined) result.sessionFile = file;
    return result;
  };

  const first =
    forked === undefined
      ? run.prompt
      : forkBrief({
          prompt: run.prompt,
          role: spec.agent.prompt,
          unavailable: briefUnavailable,
          ...(spec.isolated ? { worktree: { cwd: spec.cwd, parentCwd: parent.cwd } } : {}),
        });
  let current = runOnce(first, spec.origin);
  const handle: TaskHandle = {
    id: manager.id,
    model: `${model.provider}/${model.id}`,
    ...(manager.file() === undefined ? {} : { sessionFile: manager.file() as string }),
    send: async (text) => {
      current = runOnce(text);
    },
    observe: (listener) => child.subscribe(listener),
    entries: () => child.manager.branch(),
    message: async (text, when) => {
      if (when === "send") {
        current = runOnce(text, "direct");
        return;
      }
      if (!active || child.followUp === undefined)
        throw new AmaError("task_idle", "the sub-agent is not running");
      if (when === "interrupt") {
        // 同步登记：被中止的那一轮一结束，runOnce 就接着等这一轮
        forced.push(child.prompt(text, { origin: "direct", interrupt: true }));
        return;
      }
      await child.followUp(text, { origin: "direct" });
    },
    wait: () => current,
    stop: () => child.abort(),
    dispose: async () => {
      run.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      await child.dispose();
    },
  };
  return handle satisfies RunnerHandle;
}

function collect(
  child: ChildSession,
  error: string | undefined,
  exhausted: boolean,
  aborted: boolean,
): SubagentResult {
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
  const isError = error !== undefined || stopReason === "error" || stopReason === "aborted";
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
    isError,
    status:
      aborted || stopReason === "aborted"
        ? "aborted"
        : isError
          ? "failed"
          : exhausted
            ? "max_turns"
            : "completed",
  };
  if (stats.cache !== undefined) {
    result.cache = { reBilledTokens: stats.cache.reBilledTokens };
    if (stats.cache.hitRate !== undefined) result.cache.hitRate = stats.cache.hitRate;
  }
  return result;
}

/** 子会话命中与重计费按增量汇总进父（续聊不重复计）。 */
function addCache(
  parent: SubagentParent,
  stats: SessionStats,
  before: { cacheRead: number; prompt: number; reBilled: number },
): { cacheRead: number; prompt: number; reBilled: number } {
  const cache = stats.cache;
  if (cache === undefined) return before;
  // 不报缓存的子会话不进命中率分母（同父会话口径）
  const reported = cache.reporting === "reported";
  const { input, cacheRead, cacheWrite } = stats.tokens;
  const now = reported
    ? { cacheRead, prompt: input + cacheRead + cacheWrite, reBilled: cache.reBilledTokens }
    : { cacheRead: 0, prompt: 0, reBilled: cache.reBilledTokens };
  parent.cache?.addSubagent(
    { cacheRead: now.cacheRead - before.cacheRead, prompt: now.prompt - before.prompt },
    now.reBilled - before.reBilled,
  );
  return now;
}
