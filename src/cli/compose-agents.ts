/**
 * 子 Agent 的组装（docs/wave5-plan.md §7.1、§7.4，D22–D24）。[W5-G]
 *
 * 由 compose-extensions.ts 的一行接入：每次装配会话时发现定义文件（`--agent-dir` / profile
 * `agentDirs` → config `agents.dirs` → 用户级 → 项目级（需信任）），建类型目录并绑到 task 工具
 * （描述里的类型清单）；工厂给每个根会话装一个扩展：建任务注册表（subagent-registry.ts，并发 /
 * 排队上限与模型别名取自 config），`getStats().tasks` 汇总，会话 dispose 时停止后台任务。
 * task 子会话（depth ≥ 1）与没有 task 工具的会话不装。
 *
 * 外部 runner（claude / codex / acp:*）由 W5-E 的 ProcessRunner 在 G2 联调时经 `runners` 接入；
 * 嵌入宿主（有 profile host）时 ama 不自己 spawn 外部 Agent（D17），这里也不注册。
 */

import { subagentRegistryFor, type SubagentEnvironment } from "../agent/subagent-registry.js";
import type { SessionCore } from "../agent/session-core.js";
import type { SessionExtension, SessionExtensionFactory } from "../agent/session-extensions.js";
import { AgentCatalog } from "../agents/catalog.js";
import { agentSources, discoverAgents } from "../agents/discover.js";
import { bindTaskAgents } from "../tools/task.js";
import type { ComposeExtensionDeps } from "./compose-extensions.js";

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
      assembly.warn(`项目未信任，跳过子 Agent 定义目录 ${dir}（--trust 后生效）`);
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
  return env;
}

/** 根会话的子 Agent 扩展：注册表、任务统计、dispose 时停止后台任务。 */
export function createSubagentExtension(
  core: SessionCore,
  env: SubagentEnvironment,
): SessionExtension {
  const registry = subagentRegistryFor(core, env);
  return {
    id: "ama.subagents",
    contributeStats(stats) {
      const tasks = registry.stats();
      if (tasks !== undefined) stats.tasks = tasks;
    },
    dispose() {
      registry.dispose();
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
  bindTaskAgents(task, catalog);
  const env = subagentEnvironment(deps, catalog);
  return ({ core }) => (core.depth > 0 ? undefined : createSubagentExtension(core, env));
}
