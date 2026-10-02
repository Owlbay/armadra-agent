/**
 * ProcessRunner：把 AgentDriver 适配成 SubagentRunner（docs/wave5-plan.md §7.6、§5.3–§5.4）。[W5-E]
 *
 * 外部 CLI Agent 由此与 ama 子 Agent 共用 `task(agent=…)` 入口（D13）。`start()`：
 * 1. 只在已信任目录里起（§5.4 信任；`claude -p` 会跳过目录信任对话框并执行项目 hooks）；
 * 2. 模式夹到父会话当前模式（`agents.<id>.maxMode` 例外），再取驱动支持的不更宽的模式；
 *    按候选顺序选第一个已安装且支持该模式的驱动（D14 优先级；oneshot 只在只读下可选）；
 * 3. 会话级美元预算 `agents.sessionBudgetUsd` 用尽则不再起；
 * 4. 子进程环境按 D16 清理；并发池（总 3 / claude 2）每回合取一个名额，排队可被 abort；
 * 5. 权限请求只交给人（{@link askHuman}）；中断 / stop / 超时时挂起的请求回 cancelled；
 * 6. 每回合写 `custom{ama.agent-usage}`，会话建立写 `custom{ama.agent-session}`；
 *    只回 finalText + 工具摘要（原始事件不落盘，§5.4 敏感数据）；
 * 7. 看门狗：单回合缺省 30 min；空闲 10 min 关进程（能续接的下次 `send` 以 resume 重开）。
 */

import type { Usage } from "../ai/types.js";
import { agentEntry, type AgentsConfig } from "../config/types-w5.js";
import { AmaError } from "../errors.js";
import type { PermissionMode } from "../permissions/types.js";
import type {
  RunnerHandle,
  SubagentEvent,
  SubagentResult,
  SubagentRunRequest,
  SubagentRunner,
  SubagentStatus,
} from "../tools/types.js";
import { defaultSetTimer } from "./base.js";
import { buildChildEnv } from "./env.js";
import { askHuman, clampMode, supportedMode, type ApproveFn } from "./permissions.js";
import type { DriverPool } from "./pool.js";
import type { AgentStore } from "./store.js";
import type {
  AgentDriver,
  DriverCapabilities,
  DriverEvent,
  DriverSession,
  DriverTurnResult,
} from "./types.js";

export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const IDLE_CLOSE_MS = 10 * 60 * 1000;

export interface ProcessRunnerDeps {
  /** 审批：只交给人。接到会话的 `requestApproval`（发 permission_request、走 broker 链）。 */
  approve: ApproveFn;
  pool: DriverPool;
  store?: AgentStore;
  /** 原始环境（runner 按 D16 清理）。 */
  env: NodeJS.ProcessEnv;
  config?: AgentsConfig;
  /** 父会话当前模式（外部 Agent 不得更宽）。 */
  parentMode?(): PermissionMode;
  /** 无人值守（`-p`、RPC 未声明 approvals）：审批一律拒绝。 */
  unattended?: boolean | (() => boolean);
  /** 目录是否已被 ama 信任。 */
  trusted(cwd: string): boolean;
  /** runner id（缺省取驱动的 agentId）。 */
  id?: string;
  timeoutMs?: number;
  idleMs?: number;
  setTimer?(fn: () => void, ms: number): () => void;
  log?(level: "debug" | "info" | "warn", message: string): void;
}

function toUsage(turn: DriverTurnResult): Usage {
  const u = turn.usage ?? {};
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const cacheRead = u.cacheRead ?? 0;
  const usage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
  };
  if (u.costUsd !== undefined)
    usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.costUsd };
  return usage;
}

function statusOf(turn: DriverTurnResult, timedOut: boolean, stopped: boolean): SubagentStatus {
  if (timedOut) return "failed";
  switch (turn.stopReason) {
    case "end_turn":
    case "max_tokens":
      return "completed";
    case "max_turn_requests":
      return "max_turns";
    case "cancelled":
      return stopped ? "aborted" : "failed";
    case "refusal":
      return "failed";
  }
}

/** 最终报告：最终文本 + 工具摘要 / 触及文件（给协调者当资料，不是指令）。 */
export function reportText(turn: DriverTurnResult): string {
  const parts = [turn.finalText.trim()];
  if (turn.toolSummary.length > 0)
    parts.push(`工具调用：\n${turn.toolSummary.map((l) => `- ${l}`).join("\n")}`);
  if (turn.filesTouched.length > 0)
    parts.push(`修改的文件：\n${turn.filesTouched.map((f) => `- ${f}`).join("\n")}`);
  return parts.filter((p) => p !== "").join("\n\n");
}

function failed(text: string, sessionId: string, runner: string): SubagentResult {
  return {
    text,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "error",
    isError: true,
    status: "failed",
    ...(sessionId !== "" ? { sessionRef: { runner, sessionId } } : {}),
  };
}

export class ProcessRunner implements SubagentRunner {
  readonly id: string;
  private readonly drivers: readonly AgentDriver[];

  constructor(
    driver: AgentDriver | readonly AgentDriver[],
    private readonly deps: ProcessRunnerDeps,
  ) {
    this.drivers = Array.isArray(driver) ? driver : [driver as AgentDriver];
    if (this.drivers.length === 0)
      throw new AmaError("invalid_arguments", "ProcessRunner 需要至少一个驱动");
    this.id = deps.id ?? this.drivers[0]!.agentId;
  }

  get agentId(): string {
    return this.drivers[0]!.agentId;
  }

  private unattended(): boolean {
    const u = this.deps.unattended;
    return typeof u === "function" ? u() : u === true;
  }

  /** 选驱动：第一个已安装、且支持（不宽于）目标模式的候选。 */
  private async choose(mode: PermissionMode): Promise<{
    driver: AgentDriver;
    mode: PermissionMode;
    capabilities: DriverCapabilities;
    warning?: string;
  }> {
    const reasons: string[] = [];
    for (const driver of this.drivers) {
      const probe = await driver.probe();
      if (!probe.installed) {
        reasons.push(`${driver.kind} 未安装`);
        continue;
      }
      const usable = supportedMode(mode, probe.capabilities.modes);
      if (usable === undefined) {
        reasons.push(`${driver.kind} 不支持「${mode}」`);
        continue;
      }
      const warning = (probe as { warning?: string }).warning;
      return {
        driver,
        mode: usable,
        capabilities: probe.capabilities,
        ...(warning !== undefined ? { warning } : {}),
      };
    }
    throw new AmaError(
      "agent_unavailable",
      `外部 Agent ${this.id} 不可用（${reasons.join("；")}）`,
    );
  }

  async start(request: SubagentRunRequest): Promise<RunnerHandle> {
    if (!this.deps.trusted(request.cwd))
      throw new AmaError(
        "agent_untrusted",
        `目录 ${request.cwd} 尚未被 ama 信任，不能在这里启动外部 Agent（它会执行项目里的 hooks 与配置）；先运行 ama trust`,
      );
    const budget = this.deps.config?.sessionBudgetUsd;
    if (budget !== undefined && (this.deps.store?.totalUsd() ?? 0) >= budget)
      throw new AmaError("budget_exhausted", `本会话外部 Agent 预算 $${budget} 已用尽`);
    const entry = agentEntry(this.deps.config, this.agentId);
    const mode = clampMode(request.mode, this.deps.parentMode?.(), entry?.maxMode);
    const chosen = await this.choose(mode);
    const handle = new ProcessHandle(this, chosen, request, {
      ...this.deps,
      model: request.model ?? entry?.model,
      unattended: this.unattended(),
    });
    await handle.open(request.resume);
    handle.begin();
    return handle;
  }

  /** ProcessHandle 用。 */
  get options(): ProcessRunnerDeps {
    return this.deps;
  }
}

interface HandleDeps extends ProcessRunnerDeps {
  model: string | undefined;
  unattended: boolean;
}

class ProcessHandle implements RunnerHandle {
  private session: DriverSession | undefined;
  private sessionId = "";
  private chain: Promise<SubagentResult> = Promise.resolve(failed("尚未运行", "", ""));
  private busy = false;
  private turns = 0;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private clearIdle: (() => void) | undefined;
  private readonly agent: string;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly chosen: {
      driver: AgentDriver;
      mode: PermissionMode;
      capabilities: DriverCapabilities;
      warning?: string;
    },
    private readonly request: SubagentRunRequest,
    private readonly deps: HandleDeps,
  ) {
    this.agent = runner.agentId;
    const onAbort = (): void => void this.stop();
    if (request.signal.aborted) this.lifetime.abort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
    if (chosen.warning !== undefined)
      request.onEvent({ type: "notice", level: "warn", text: chosen.warning });
    if (chosen.mode !== request.mode)
      request.onEvent({
        type: "notice",
        level: "info",
        text: `${this.agent} 以「${chosen.mode}」模式运行（请求的是「${request.mode}」，外部 Agent 不得比 ama 当前模式宽）`,
      });
  }

  get id(): string {
    return this.sessionId;
  }

  async open(resume: string | undefined): Promise<void> {
    const env = buildChildEnv(this.deps.env, this.agent, this.deps.config);
    const session = await this.chosen.driver.open({
      cwd: this.request.cwd,
      mode: this.chosen.mode,
      env,
      signal: this.lifetime.signal,
      unattended: this.deps.unattended,
      ...(this.deps.model !== undefined ? { model: this.deps.model } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(this.request.budgetUsd !== undefined ? { budgetUsd: this.request.budgetUsd } : {}),
    });
    this.session = session;
    this.sessionId = session.sessionId;
    this.deps.store?.recordSession({
      agent: this.agent,
      runner: this.chosen.driver.kind,
      sessionId: session.sessionId,
      cwd: this.request.cwd,
    });
  }

  /** 第一回合。 */
  begin(): void {
    this.chain = this.runTurn(this.request.prompt);
  }

  async send(text: string): Promise<void> {
    if (this.stopped) throw new AmaError("agent_closed", `${this.agent} 已停止`);
    if (this.busy && this.session?.steer !== undefined && this.chosen.capabilities.steer) {
      await this.session.steer([{ type: "text", text }]);
      return;
    }
    this.chain = this.chain.then(() => this.runTurn(text));
  }

  wait(): Promise<SubagentResult> {
    return this.chain;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    this.clearIdle?.();
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) {
      await session.cancel().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }

  private emit(event: SubagentEvent): void {
    try {
      this.request.onEvent(event);
    } catch (error) {
      this.deps.log?.("warn", `subagent onEvent failed: ${String(error)}`);
    }
  }

  private onDriverEvent(event: DriverEvent, turnCost: { usd: number }, cancel: () => void): void {
    switch (event.type) {
      case "message_delta":
        this.emit({ type: "text", delta: event.text });
        return;
      case "thought_delta":
        this.emit({ type: "thought", delta: event.text });
        return;
      case "tool_call":
        if (event.status === "pending") return;
        this.emit({
          type: "tool",
          toolName: event.title,
          status:
            event.status === "in_progress"
              ? "started"
              : event.status === "failed"
                ? "failed"
                : "completed",
        });
        return;
      case "notice":
        this.emit({ type: "notice", level: event.level, text: event.text });
        return;
      case "usage":
        if (event.costUsd !== undefined) {
          turnCost.usd = event.costUsd;
          const budget = this.request.budgetUsd;
          const session = this.deps.config?.sessionBudgetUsd;
          const spent = this.deps.store?.totalUsd() ?? 0;
          if (
            (budget !== undefined && turnCost.usd > budget) ||
            (session !== undefined && spent + turnCost.usd > session)
          ) {
            this.emit({
              type: "notice",
              level: "warn",
              text: `${this.agent} 超出美元预算，已中断`,
            });
            cancel();
          }
        }
        return;
      default:
        return;
    }
  }

  /** 关掉空闲进程后再续聊：能续接的以 resume 重开。 */
  private async ensureSession(): Promise<DriverSession> {
    if (this.session !== undefined) return this.session;
    if (this.chosen.capabilities.resume === "none" || this.sessionId === "")
      throw new AmaError("agent_closed", `${this.agent} 会话已因空闲关闭且不支持续接`);
    await this.open(this.sessionId);
    return this.session as unknown as DriverSession;
  }

  private async runTurn(text: string): Promise<SubagentResult> {
    if (this.stopped) return failed(`${this.agent} 已停止`, this.sessionId, this.runner.id);
    this.clearIdle?.();
    let release: (() => void) | undefined;
    const setTimer = this.deps.setTimer ?? defaultSetTimer;
    let timedOut = false;
    try {
      release = await this.deps.pool.acquire(this.agent, this.lifetime.signal);
      const session = this.session ?? (await this.ensureSession());
      this.busy = true;
      this.turns += 1;
      this.emit({ type: "turn", turn: this.turns });
      const turnCost = { usd: 0 };
      const cancel = (): void => void session.cancel();
      const clearTimeout = setTimer(() => {
        timedOut = true;
        this.emit({ type: "notice", level: "warn", text: `${this.agent} 运行超时，已中断` });
        cancel();
      }, this.deps.timeoutMs ?? RUN_TIMEOUT_MS);
      const onAbort = (): void => cancel();
      this.lifetime.signal.addEventListener("abort", onAbort, { once: true });
      let turn: DriverTurnResult;
      try {
        turn = await session.prompt([{ type: "text", text }], {
          onEvent: (e) => this.onDriverEvent(e, turnCost, cancel),
          onPermission: (req, signal) =>
            askHuman(req, {
              agent: this.agent,
              sessionId: session.sessionId,
              unattended: this.deps.unattended,
              approve: this.deps.approve,
              signal: AbortSignal.any([signal, this.lifetime.signal]),
            }),
        });
      } finally {
        clearTimeout();
        this.lifetime.signal.removeEventListener("abort", onAbort);
        this.busy = false;
      }
      this.sessionId = session.sessionId;
      const usage = toUsage(turn);
      const unit = this.chosen.capabilities.usage;
      if (unit !== "none") {
        const amount =
          unit === "usd"
            ? (turn.usage?.costUsd ?? turnCost.usd)
            : unit === "tokens"
              ? usage.input + usage.output
              : 1;
        this.deps.store?.recordUsage({
          agent: this.agent,
          sessionId: this.sessionId,
          unit,
          amount,
          ...(usage.totalTokens > 0 ? { tokens: usage.totalTokens } : {}),
        });
        this.emit({ type: "usage", usage, unit, amount });
      }
      const status = statusOf(turn, timedOut, this.stopped);
      this.armIdle();
      return {
        text: timedOut
          ? `${this.agent} 运行超时被中断。${turn.finalText !== "" ? `\n\n${reportText(turn)}` : ""}`
          : reportText(turn),
        usage,
        stopReason: timedOut ? "timeout" : turn.stopReason,
        isError: status === "failed",
        status,
        sessionRef: { runner: this.runner.id, sessionId: this.sessionId },
      };
    } catch (error) {
      if (this.stopped)
        return {
          ...failed(`${this.agent} 已停止`, this.sessionId, this.runner.id),
          status: "aborted",
        };
      return failed(
        `${this.agent} 失败：${(error as Error).message}`,
        this.sessionId,
        this.runner.id,
      );
    } finally {
      release?.();
    }
  }

  /** 空闲一段时间关进程（不占资源）；能续接的下次 send 再起。 */
  private armIdle(): void {
    if (this.chosen.capabilities.resume === "none") return;
    const setTimer = this.deps.setTimer ?? defaultSetTimer;
    this.clearIdle = setTimer(() => {
      if (this.busy || this.stopped) return;
      const session = this.session;
      this.session = undefined;
      void session?.close().catch(() => undefined);
    }, this.deps.idleMs ?? IDLE_CLOSE_MS);
  }
}

/** §10.2 的签名：`createProcessRunner(driver, { approve, pool, store, … })`。 */
export function createProcessRunner(
  driver: AgentDriver | readonly AgentDriver[],
  deps: ProcessRunnerDeps,
): ProcessRunner {
  return new ProcessRunner(driver, deps);
}
