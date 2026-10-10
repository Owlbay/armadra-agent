/**
 * 外部 Agent 接入 `task(agent=…)`（docs/history/wave5-plan.md §5.3–§5.5、§7.3、§7.6，D13、D15、D17）。[W5-EG]
 *
 * - 名字：`claude` / `codex` / `acp:<program>` / 驱动表里的其它 id（`gemini` …，`ama` 除外——那是子会话
 *   类型的 runner 名；ama 自己经 ACP 用 `acp:ama`）/ 宿主注入的 runner id（宿主注入的 `ama` 在类型里的 runner
 *   名是 `host:ama`，交给宿主；没注入时 `ama` 照旧不是外部 Agent）。启动时 PATH 上找得到的
 *   claude / codex 与已注入的宿主 runner 登记进类型目录（进 task 工具描述）；其余按需解析（不进描述，
 *   描述在会话内字节不变）。
 * - 每个主会话一个 {@link ExternalAgents}：审批接 `requestApproval`（只走 broker 链，不经 gateToolCall
 *   与 auto 分类器）；有宿主时不自 spawn（D17），只认宿主注入的。
 * - 首次在本会话以某个外部 Agent 运行：一次 `execute` 类确认「将以你在 X 的现有登录运行，模式 Y」——
 *   deny 规则 `task(<id>)` 拒绝；allow 规则 `task` / `task(<id>)` 或 full-auto 放行；allowlist 与无人值守
 *   拒绝；其余问人。宿主 runner 不问（宿主自己管审批）。
 * - 句柄包一层：被 stop 的外部任务续聊时以外部会话 id `resume` 重开。
 * - `/agents`、RPC `get_agents` 的外部部分要探测（异步），这里按会话缓存，启动与变化时刷新。
 */

import { randomUUID } from "node:crypto";
import type { SessionCore } from "../agent/session-core.js";
import { requestApproval } from "../agent/session-tools.js";
import { agentEntry, type AgentsConfig } from "../config/types-w5.js";
import { ExternalAgents } from "../drivers/agents.js";
import type { DriverDeps } from "../drivers/base.js";
import { candidatesFor, catalogEntry } from "../drivers/catalog.js";
import type { HostRunnerRegistry } from "../drivers/host-runners.js";
import { clampMode } from "../drivers/permissions.js";
import { findOnPath } from "../drivers/probe.js";
import { createAgentStore } from "../drivers/store.js";
import { AmaError } from "../errors.js";
import type { HostRunner } from "../host/types.js";
import { findAllowRule, findDenyRule } from "../permissions/rules.js";
import type { ApprovalRequest, PermissionMode } from "../permissions/types.js";
import type {
  RunnerHandle,
  SubagentResult,
  SubagentRunRequest,
  SubagentRunner,
} from "../tools/types.js";
import type { AgentCatalog } from "./catalog.js";
import type { AgentDefinition, AgentInfo, AgentRunnerSpec } from "./types.js";

/** 启动时按 PATH 登记进 task 描述的外部 Agent。 */
export const LISTED_EXTERNAL_AGENTS = ["claude", "codex"] as const;

/** 关闭外部 Agent 的 PATH 探测与版本探测（测试；`/agents` 只列类型目录）。 */
export const NO_AGENT_PROBE_ENV = "AMA_NO_AGENT_PROBE";

/** 测试注入（spawn / probe）：进程内对端代替真实子进程。生产代码不设置。 */
export const externalTesting: { driverDeps?: DriverDeps } = {};

/** 是不是外部 Agent 的名字（`claude` / `codex` / `acp:<program>` / 驱动表 id，`ama` 除外）。 */
export function isExternalSpec(name: string): boolean {
  if (name === "ama") return false;
  if (name.startsWith("acp:")) return name.slice(4).trim() !== "";
  return catalogEntry(name) !== undefined;
}

function labelOf(spec: string): string {
  return (
    catalogEntry(spec)?.label ?? (spec.startsWith("acp:") ? `ACP agent ${spec.slice(4)}` : spec)
  );
}

function definition(
  name: string,
  runner: string,
  description: string,
  source: AgentDefinition["source"],
): AgentDefinition {
  return {
    name,
    description,
    permissionMode: "inherit",
    model: "inherit",
    maxTurns: 30,
    isolation: "none",
    // 驱动表 id（gemini 等）与宿主 id 不在 AgentRunnerSpec 的字面量里，线上照样是字符串
    runner: runner as AgentRunnerSpec,
    prompt: "",
    source,
  };
}

/** 外部 CLI 的类型（`task(agent="claude")`）。 */
export function externalDefinition(spec: string): AgentDefinition {
  return definition(
    spec,
    spec,
    `External ${labelOf(spec)} CLI (its own login, model and permission policy; full instructions in prompt).`,
    "builtin",
  );
}

/**
 * 宿主注入的 id 恰为 `ama` 的 runner（画布上另一个 ama 节点）在类型里的 runner 名。裸 `ama` 是子会话
 * 类型的 runner 名（注册表按它起子会话），不能共用；名字仍是 `ama`，`task(agent="ama")` 照常解析。
 */
export const HOST_AMA_RUNNER = "host:ama";

/** 宿主 runner id → 类型里的 runner 名。 */
function hostRunnerName(id: string): string {
  return id === "ama" ? HOST_AMA_RUNNER : id;
}

export function hostDefinition(runner: HostRunner): AgentDefinition {
  return definition(runner.id, hostRunnerName(runner.id), runner.description, "host");
}

/** 只查 PATH（不起进程）：候选链里任一程序在 PATH 上。 */
export function externalOnPath(spec: string, env: NodeJS.ProcessEnv): boolean {
  const found = candidatesFor(spec);
  return found?.candidates.some((c) => findOnPath(c.program, env) !== undefined) ?? false;
}

export interface ExternalWiring {
  env: NodeJS.ProcessEnv;
  /** 有宿主适配器：不自 spawn 外部 CLI（D17）。 */
  hosted: boolean;
  hostRunners?: HostRunnerRegistry;
  dataDir?: string;
  config?: AgentsConfig;
  /** config `subagents.defaultModel`：那是 ama 的模型，不传给外部 CLI。 */
  defaultModel?: string;
  /** 项目是否已被 ama 信任。 */
  trusted: boolean;
  /** PATH 与版本探测（`AMA_NO_AGENT_PROBE=1` 关闭）。 */
  probe: boolean;
}

/** 启动时登记：PATH 上的 claude / codex（无宿主时）与已注入的宿主 runner；其余按需解析。 */
export function registerExternalAgents(catalog: AgentCatalog, wiring: ExternalWiring): void {
  for (const runner of wiring.hostRunners?.list() ?? []) catalog.add(hostDefinition(runner));
  if (!wiring.hosted && wiring.probe)
    for (const spec of LISTED_EXTERNAL_AGENTS)
      if (externalOnPath(spec, wiring.env)) catalog.add(externalDefinition(spec));
  catalog.setResolver((name) => {
    const hosted = wiring.hostRunners?.get(name);
    if (hosted !== undefined) return hostDefinition(hosted);
    return isExternalSpec(name) ? externalDefinition(name) : undefined;
  });
}

/** 续聊时能重开的句柄：被 stop 的外部会话以 `resume` 接上（同一任务、同一外部会话）。 */
class ExternalTaskHandle implements RunnerHandle {
  private stopped = false;

  constructor(
    private inner: RunnerHandle,
    private readonly reopen: (resume: string, prompt: string) => Promise<RunnerHandle>,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  async send(text: string): Promise<void> {
    if (!this.stopped) {
      try {
        await this.inner.send(text);
        return;
      } catch (error) {
        if (!(error instanceof AmaError) || error.code !== "agent_closed") throw error;
      }
    }
    if (this.inner.id === "")
      throw new AmaError(
        "agent_closed",
        "the external agent session was never established; cannot continue it",
      );
    this.inner = await this.reopen(this.inner.id, text);
    this.stopped = false;
  }

  wait(): Promise<SubagentResult> {
    return this.inner.wait();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.inner.stop();
  }
}

/**
 * 启动返回前到达的进度事件（第一回合的 `turn` 等）推迟到注册表发出 `subagent_start` 之后：
 * 注册表在 `start()` resolve 后的微任务里发 start，这里在下一个宏任务再放行。
 */
function deferEvents(request: SubagentRunRequest): {
  request: SubagentRunRequest;
  release(): void;
} {
  let queue: Parameters<SubagentRunRequest["onEvent"]>[0][] | undefined = [];
  const onEvent: SubagentRunRequest["onEvent"] = (event) => {
    if (queue !== undefined) queue.push(event);
    else request.onEvent(event);
  };
  return {
    request: { ...request, onEvent },
    release() {
      setImmediate(() => {
        const pending = queue ?? [];
        queue = undefined;
        for (const event of pending) request.onEvent(event);
      });
    },
  };
}

const infoCache = new Map<string, AgentInfo[]>();

/** RPC `get_agents` / `/agents`：会话的类型与外部 Agent（含安装与版本）；未缓存返回 undefined。 */
export function cachedAgentInfos(sessionId: string): AgentInfo[] | undefined {
  return infoCache.get(sessionId);
}

/** 合并：类型目录在前；外部探测结果补 installed / version，目录里没有的追加在后。 */
export function mergeAgentInfos(
  base: readonly AgentInfo[],
  external: readonly AgentInfo[],
): AgentInfo[] {
  const out = base.map((info) => ({ ...info }));
  for (const raw of external) {
    // 驱动表里的 ama 经 ACP 驱动，名字是 acp:ama（裸 ama 是子会话类型的 runner 名）
    const probe = raw.name === "ama" ? { ...raw, name: "acp:ama", runner: "acp:ama" } : raw;
    const known = out.find((info) => info.name === probe.name);
    if (known === undefined) {
      out.push({ ...probe });
      continue;
    }
    if (probe.installed !== undefined) known.installed = probe.installed;
    if (probe.version !== undefined) known.version = probe.version;
  }
  return out;
}

/** 一个主会话的外部 Agent 入口（`SubagentEnvironment.runners` 的实现）。 */
export class SessionExternalAgents {
  readonly agents: ExternalAgents;
  private readonly approved = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private disposed = false;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly core: SessionCore,
    private readonly wiring: ExternalWiring,
    private readonly catalog: AgentCatalog,
  ) {
    const store = createAgentStore({
      appendCustom: (customType, data) =>
        void core.appendEntry({ type: "custom", customType, data }),
      entries: () => core.manager.branch(),
    });
    const driverDeps = externalTesting.driverDeps;
    this.agents = new ExternalAgents({
      env: wiring.env,
      cwd: core.cwd,
      hosted: wiring.hosted,
      ...(wiring.hostRunners !== undefined ? { hostRunners: wiring.hostRunners } : {}),
      ...(wiring.dataDir !== undefined ? { dataDir: wiring.dataDir } : {}),
      ...(wiring.config !== undefined ? { config: wiring.config } : {}),
      approve: (request, signal) => requestApproval(core, request, signal),
      store,
      parentMode: () => this.mode(),
      unattended: () => core.options.unattended === true,
      trusted: () => wiring.trusted,
      ...(driverDeps !== undefined ? { driverDeps } : {}),
      log: (level, message) => core.log(level, message),
    });
    this.unsubscribe = wiring.hostRunners?.onChange(() => void this.refreshInfos());
  }

  private mode(): PermissionMode {
    return this.core.options.permission?.mode ?? "default";
  }

  /** 注册表的 `runners(agent)`：ama 子会话类型返回 undefined。 */
  runner(agent: AgentDefinition): SubagentRunner | undefined {
    if (agent.runner === "ama") return undefined;
    // 宿主注入的 `ama` 走宿主；宿主已注销时报不可用，不退回自起（驱动表里也有一个 ama）。
    // 宿主 id 不在 AgentRunnerSpec 的字面量里（见 definition），按字符串比
    const runnerName: string = agent.runner;
    const hostAma = runnerName === HOST_AMA_RUNNER;
    const spec = hostAma ? "ama" : agent.runner;
    const host = this.wiring.hostRunners?.get(spec);
    if (hostAma && host === undefined) {
      const error = new AmaError(
        "agent_host_only",
        `"ama" was provided by the host and is no longer available`,
      );
      return { id: spec, start: () => Promise.reject(error) };
    }
    let inner: SubagentRunner;
    try {
      inner = this.agents.resolve(spec);
    } catch (error) {
      // 不可用的原因（宿主环境、未知 id）作为任务失败的说明返回给模型
      return { id: spec, start: () => Promise.reject(error) };
    }
    return {
      id: inner.id,
      start: async (request) => {
        if (host === undefined) await this.firstRun(spec, request);
        const events = deferEvents(request);
        const handle = await inner.start(this.forward(spec, events.request));
        events.release();
        void handle.wait().finally(() => void this.refreshInfos());
        if (host !== undefined) return handle;
        const reopen = async (resume: string, prompt: string): Promise<RunnerHandle> => {
          return inner.start({
            ...this.forward(spec, request),
            prompt,
            resume,
            mode: this.mode(),
            signal: new AbortController().signal,
          });
        };
        return new ExternalTaskHandle(handle, reopen);
      },
    };
  }

  /** 发给外部 runner 的请求：去掉 ama 自己的缺省模型（`subagents.defaultModel`）。 */
  private forward(spec: string, request: SubagentRunRequest): SubagentRunRequest {
    const own = agentEntry(this.wiring.config, spec)?.model;
    if (
      request.model !== undefined &&
      request.model === this.wiring.defaultModel &&
      request.model !== own
    ) {
      const { model: _ama, ...rest } = request;
      return rest;
    }
    return request;
  }

  /** 首次在本会话以 `spec` 运行的确认（同一 Agent 并发的首次只问一次）。 */
  private firstRun(spec: string, request: SubagentRunRequest): Promise<void> {
    if (this.approved.has(spec)) return Promise.resolve();
    let pending = this.pending.get(spec);
    if (pending === undefined) {
      pending = this.confirm(spec, request).finally(() => this.pending.delete(spec));
      this.pending.set(spec, pending);
    }
    return pending;
  }

  private async confirm(spec: string, request: SubagentRunRequest): Promise<void> {
    const core = this.core;
    const mode = this.mode();
    const rules = core.options.permission?.rules ?? [];
    const subject = { command: spec };
    const label = labelOf(spec);
    if (findDenyRule(rules, "task", subject, core.cwd) !== undefined)
      throw new AmaError(
        "permission_denied",
        `A deny rule blocks running ${label} (task(${spec})).`,
      );
    let decision: "allow" | "ask" | "deny" =
      findAllowRule(rules, "task", subject, core.cwd) !== undefined || mode === "full-auto"
        ? "allow"
        : mode === "allowlist"
          ? "deny"
          : "ask";
    if (decision === "ask" && core.options.unattended === true) decision = "deny";
    if (decision === "deny")
      throw new AmaError(
        "permission_denied",
        `Running ${label} needs approval the first time in a session, and nobody can approve it here. ` +
          `Add an allow rule task(${spec}) to permit it.`,
      );
    if (decision === "ask") {
      const effective = clampMode(
        request.mode,
        mode,
        agentEntry(this.wiring.config, spec)?.maxMode,
      );
      const approval: ApprovalRequest = {
        requestId: randomUUID(),
        toolName: "task",
        input: {
          agent: spec,
          mode: effective,
          note: `Runs ${label} with your existing login in that CLI (mode ${effective}).`,
        },
        reason: "mode",
        context: { depth: 0, ...(request.taskId !== undefined ? { taskId: request.taskId } : {}) },
      };
      const answer = await requestApproval(core, approval, request.signal);
      if (answer === "deny")
        throw new AmaError("permission_denied", `The user declined running ${label}.`);
    }
    this.approved.add(spec);
  }

  /** 重新探测并缓存 `/agents` 的数据（不阻塞；会话关闭后不再写）。 */
  async refreshInfos(): Promise<AgentInfo[]> {
    const base = this.catalog.infos();
    let external: AgentInfo[] = [];
    if (this.wiring.probe || this.wiring.hosted) {
      try {
        external = await this.agents.list();
      } catch (error) {
        this.core.log("warn", `external agent probe failed: ${String(error)}`);
      }
    }
    const merged = mergeAgentInfos(base, external);
    if (!this.disposed) infoCache.set(this.core.manager.id, merged);
    return merged;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    infoCache.delete(this.core.manager.id);
  }
}
