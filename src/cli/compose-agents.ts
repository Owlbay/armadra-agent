/**
 * 子 Agent 的组装（docs/wave5-plan.md §7.1、§7.4，D22–D24）。[W5-G]
 *
 * 由 compose-extensions.ts 的一行接入：每次装配会话时发现定义文件（`--agent-dir` / profile
 * `agentDirs` → config `agents.dirs` → 用户级 → 项目级（需信任）），建类型目录并绑到 task 工具
 * （描述里的类型清单）；工厂给每个根会话装一个扩展：建任务注册表（subagent-registry.ts，并发 /
 * 排队上限与模型别名取自 config），`getStats().tasks` 汇总，会话 dispose 时停止后台任务。
 * task 子会话（depth ≥ 1）与没有 task 工具的会话不装。[W7-B1] `subagents.background`（auto：交互 / RPC /
 * ACP 后台、`-p` 前台）解析成本进程的缺省，同时决定 task 描述的版本；`autoBackgroundAfterMs` 透传。
 *
 * [W5-EG] 外部 runner（claude / codex / acp:* / 宿主注入）经 agents/external.ts 接入 `runners`：每个主
 * 会话一个 ExternalAgents（审批接 requestApproval，只交给人）；PATH 上的 claude / codex 登记进类型
 * 目录；嵌入宿主（有宿主适配器）时 ama 不自己 spawn 外部 Agent、也不登记（D17），只认
 * `HostApi.runners.provide` 注入的。`/agents` / RPC `get_agents` 的外部探测在会话建立时异步缓存。
 */

import { subagentRegistryFor, type SubagentEnvironment } from "../agent/subagent-registry.js";
import type { SessionCore } from "../agent/session-core.js";
import type { SessionExtension, SessionExtensionFactory } from "../agent/session-extensions.js";
import { AgentCatalog } from "../agents/catalog.js";
import { agentSources, discoverAgents } from "../agents/discover.js";
import {
  NO_AGENT_PROBE_ENV,
  SessionExternalAgents,
  registerExternalAgents,
  type ExternalWiring,
} from "../agents/external.js";
import { hostRunnersOf } from "../host/api-impl.js";
import { bindTaskAgents, bindTaskBackground } from "../tools/task.js";
import { resolveTaskBackground, type BackgroundSetting } from "../agent/subagent-background.js";
import type { ComposeExtensionDeps } from "./compose-extensions.js";
import { msg } from "../i18n/index.js";

/** 同一装配材料只提示一次（`/new` 等会重新装配会话）。 */
const warned = new WeakSet<object>();

export function loadAgentCatalog(deps: ComposeExtensionDeps): AgentCatalog {
  const { assembly } = deps;
  const found = discoverAgents(
    agentSources({
      cwd: assembly.paths.cwd,
      configDir: assembly.paths.configDir,
      cliDirs: assembly.overrides?.agentDirs ?? [],
      configDirs: assembly.config.agents?.dirs ?? [],
    }),
    { trusted: assembly.trust.trusted },
  );
  if (!warned.has(assembly)) {
    warned.add(assembly);
    for (const warning of found.warnings) assembly.warn(warning);
    for (const dir of found.skippedUntrusted)
      assembly.warn(msg().cli.composeAgents.untrustedAgentDir(dir));
  }
  return new AgentCatalog(found.agents);
}

export function subagentEnvironment(
  deps: ComposeExtensionDeps,
  catalog: AgentCatalog,
): SubagentEnvironment {
  const config = deps.assembly.config;
  const env: SubagentEnvironment = {
    catalog,
    modelConfig: {
      ...(config.agents === undefined ? {} : { agents: config.agents }),
      ...(config.subagents === undefined ? {} : { subagents: config.subagents }),
      ...(config.models === undefined ? {} : { models: config.models }),
    },
  };
  const max = config.subagents?.maxConcurrent;
  if (max !== undefined) env.maxConcurrent = max;
  const pending = config.subagents?.maxPending;
  if (pending !== undefined) env.maxPending = pending;
  // [W7-B1] 缺省后台与自动转后台（配置键由 W7-B2 登记；这里按可选值读）
  const sub = config.subagents as
    { background?: BackgroundSetting; autoBackgroundAfterMs?: number } | undefined;
  env.background = resolveTaskBackground(sub?.background, deps.assembly.unattended === true);
  const after = sub?.autoBackgroundAfterMs;
  if (typeof after === "number" && after > 0) env.autoBackgroundAfterMs = after;
  return env;
}

/** 外部 Agent 的装配材料（宿主、信任、探测开关取自装配材料与环境）。 */
export function externalWiring(deps: ComposeExtensionDeps): ExternalWiring {
  const { assembly } = deps;
  const api = assembly.host.handle?.api;
  const hostRunners = api === undefined ? undefined : hostRunnersOf(api);
  const config = assembly.config;
  const wiring: ExternalWiring = {
    env: deps.env,
    hosted: assembly.host.handle !== undefined,
    dataDir: assembly.paths.dataDir,
    trusted: assembly.trust.trusted,
    probe: deps.env[NO_AGENT_PROBE_ENV] !== "1",
  };
  if (hostRunners !== undefined) wiring.hostRunners = hostRunners;
  if (config.agents !== undefined) wiring.config = config.agents;
  const defaultModel = config.subagents?.defaultModel;
  if (defaultModel !== undefined) wiring.defaultModel = defaultModel;
  return wiring;
}

/** 根会话的子 Agent 扩展：注册表、任务统计、dispose 时停止后台任务。 */
export function createSubagentExtension(
  core: SessionCore,
  env: SubagentEnvironment,
  wiring?: ExternalWiring,
): SessionExtension {
  const external =
    wiring === undefined ? undefined : new SessionExternalAgents(core, wiring, env.catalog);
  const registry = subagentRegistryFor(
    core,
    external === undefined ? env : { ...env, runners: (agent) => external.runner(agent) },
  );
  // RPC get_agents / `/agents` 的外部探测（异步，结果缓存）；-p 不需要
  if (external !== undefined && core.options.unattended !== true) void external.refreshInfos();
  return {
    id: "ama.subagents",
    contributeStats(stats) {
      const tasks = registry.stats();
      if (tasks !== undefined) stats.tasks = tasks;
    },
    dispose() {
      registry.dispose();
      external?.dispose();
    },
  };
}

export function createSubagentsFactory(deps: ComposeExtensionDeps): SessionExtensionFactory {
  // 组装表的单元测试给的是不完整的装配材料
  const task = (deps.assembly.tools as Partial<typeof deps.assembly.tools> | undefined)?.get?.(
    "task",
  );
  if (task === undefined) return () => undefined;
  const catalog = loadAgentCatalog(deps);
  const wiring = externalWiring(deps);
  registerExternalAgents(catalog, wiring);
  bindTaskAgents(task, catalog);
  const env = subagentEnvironment(deps, catalog);
  bindTaskBackground(task, env.background === true);
  return ({ core }) => (core.depth > 0 ? undefined : createSubagentExtension(core, env, wiring));
}
