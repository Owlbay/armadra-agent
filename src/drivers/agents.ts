/**
 * 外部 Agent 的入口（W5-G 的 `task(agent=…)` 经它拿 runner，docs/wave5-plan.md §5.5、§7.6、D13、D17）。[W5-E]
 *
 * - `resolve("claude" | "codex" | "acp:<program>" | 表里的 id)` → {@link ProcessRunner}（按驱动表候选链，
 *   每次 `start` 时按模式与安装情况选驱动）；同一 spec 复用同一个 runner。
 * - 宿主（`HostApi.runners.provide`）注入的 runner 优先：同名替换内置外部 runner。
 * - **有宿主（profile.host）时不自 spawn**：内置外部 runner 一律不可用，只认宿主注入的（D17；绕过画布
 *   spawn 会让节点、连线授权与审批全部失效）。
 * - 共用一个并发池、一个探测缓存（`<dataDir>/drivers.json`）与 pid 登记（`<dataDir>/drivers/pids.json`；
 *   首次创建时清理上次崩溃留下的孤儿进程）。
 */

import { join } from "node:path";
import type { AgentInfo } from "../agents/types.js";
import type { AgentsConfig } from "../config/types-w5.js";
import { AmaError } from "../errors.js";
import type { PermissionMode } from "../permissions/types.js";
import type { SubagentRunner } from "../tools/types.js";
import { AcpDriver } from "./acp/driver.js";
import type { DriverDeps } from "./base.js";
import { DRIVER_CATALOG, candidatesFor, type CatalogCandidate } from "./catalog.js";
import { HostRunnerRegistry } from "./host-runners.js";
import { ClaudeStreamDriver } from "./native/claude-stream.js";
import { CodexAppServerDriver } from "./native/codex-app-server.js";
import { OneshotDriver } from "./native/oneshot.js";
import { PiRpcDriver } from "./native/pi-rpc.js";
import type { ApproveFn } from "./permissions.js";
import { PidRegistry, pidsFile } from "./pids.js";
import { poolFromConfig, type DriverPool } from "./pool.js";
import { ProgramProbe } from "./probe.js";
import { spawnTransport } from "./process.js";
import { ProcessRunner } from "./runner.js";
import type { AgentStore } from "./store.js";
import type { AgentDriver } from "./types.js";
import { msg } from "../i18n/index.js";

/** 按候选种类建驱动。 */
export function createDriver(
  agentId: string,
  candidate: CatalogCandidate,
  deps: DriverDeps,
): AgentDriver {
  switch (candidate.kind) {
    case "acp":
    case "acp-adapter":
      return new AcpDriver(agentId, candidate, deps);
    case "claude-stream":
      return new ClaudeStreamDriver(agentId, candidate, deps);
    case "codex-app-server":
      return new CodexAppServerDriver(agentId, candidate, deps);
    case "pi-rpc":
      return new PiRpcDriver(agentId, candidate, deps);
    case "oneshot":
      return new OneshotDriver(agentId, candidate, deps);
  }
}

export { HostRunnerRegistry };

export interface ExternalAgentsOptions {
  config?: AgentsConfig;
  /** 原始环境（子进程环境由 runner 按 D16 清理）。 */
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** 探测缓存与 pid 登记的位置；不给则只做内存缓存、不登记。 */
  dataDir?: string;
  /** 有宿主（profile.host）：只认宿主注入的 runner。 */
  hosted: boolean;
  /** 宿主注入的 runner（宿主适配器一份，跨会话共享）；不给则本实例自建一份。 */
  hostRunners?: HostRunnerRegistry;
  /** 审批只交给人：接到会话的 requestApproval。 */
  approve: ApproveFn;
  store?: AgentStore;
  parentMode?(): PermissionMode;
  unattended?: boolean | (() => boolean);
  trusted(cwd: string): boolean;
  /** 测试 / 宿主注入（spawn、probe）。 */
  driverDeps?: DriverDeps;
  log?(level: "debug" | "info" | "warn", message: string): void;
}

let reaped = false;

export class ExternalAgents {
  readonly hostRunners: HostRunnerRegistry;
  readonly pool: DriverPool;
  private readonly runners = new Map<string, ProcessRunner>();
  private readonly driverDeps: DriverDeps;

  constructor(private readonly options: ExternalAgentsOptions) {
    this.hostRunners = options.hostRunners ?? new HostRunnerRegistry();
    this.pool = poolFromConfig(options.config);
    const registry =
      options.dataDir !== undefined ? new PidRegistry(pidsFile(options.dataDir)) : undefined;
    if (registry !== undefined && !reaped && options.driverDeps?.spawn === undefined) {
      reaped = true;
      void registry
        .reapOrphans()
        .then((killed) => {
          if (killed.length > 0)
            options.log?.("info", msg().drivers.agent.reapedOrphans(killed.join(", ")));
        })
        .catch(() => undefined);
    }
    const log = options.log;
    this.driverDeps = {
      probe: new ProgramProbe({
        env: options.env,
        cwd: options.cwd,
        ...(options.dataDir !== undefined
          ? { cacheFile: join(options.dataDir, "drivers.json") }
          : {}),
      }),
      spawn: (spec) =>
        spawnTransport(spec, {
          onSpawn: (pid) => registry?.add(pid, spec.program),
          onExit: (pid) => registry?.remove(pid),
        }),
      ...(log !== undefined ? { log } : {}),
      ...options.driverDeps,
    };
  }

  /** `task(agent=<spec>)` 的 runner；不可用时抛 AmaError（`agent_host_only` / `agent_unknown`）。 */
  resolve(spec: string): SubagentRunner {
    const hosted = this.hostRunners.get(spec);
    if (hosted !== undefined) return hosted;
    if (this.options.hosted)
      throw new AmaError(
        "agent_host_only",
        `when embedded, external agents come from the host: "${spec}" was not provided by the host (ama does not start external CLIs itself)`,
      );
    const cached = this.runners.get(spec);
    if (cached !== undefined) return cached;
    const found = candidatesFor(spec);
    if (found === undefined) throw new AmaError("agent_unknown", `unknown external agent: ${spec}`);
    const drivers = found.candidates.map((c) => createDriver(found.agentId, c, this.driverDeps));
    const o = this.options;
    const runner = new ProcessRunner(drivers, {
      approve: o.approve,
      pool: this.pool,
      env: o.env,
      trusted: o.trusted,
      ...(o.store !== undefined ? { store: o.store } : {}),
      ...(o.config !== undefined ? { config: o.config } : {}),
      ...(o.parentMode !== undefined ? { parentMode: o.parentMode } : {}),
      ...(o.unattended !== undefined ? { unattended: o.unattended } : {}),
      ...(o.log !== undefined ? { log: o.log } : {}),
    });
    this.runners.set(spec, runner);
    return runner;
  }

  /** `/agents` 与 RPC `get_agents` 的外部 Agent 部分（探测 PATH 与版本，不联网）。 */
  async list(): Promise<AgentInfo[]> {
    const out: AgentInfo[] = this.hostRunners.list().map((r) => ({
      name: r.id,
      description: r.description,
      runner: r.id,
      source: "host",
    }));
    if (this.options.hosted) return out;
    for (const entry of DRIVER_CATALOG) {
      if (out.some((a) => a.name === entry.agentId)) continue;
      let installed = false;
      let version: string | undefined;
      for (const c of entry.candidates) {
        const probe = await createDriver(entry.agentId, c, this.driverDeps).probe();
        if (probe.installed) {
          installed = true;
          version = probe.version;
          break;
        }
      }
      out.push({
        name: entry.agentId,
        description: entry.label,
        runner: entry.agentId,
        source: "builtin",
        installed,
        ...(version !== undefined ? { version } : {}),
      });
    }
    return out;
  }
}
