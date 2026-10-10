/**
 * 子 Agent 类型目录：内置 ⊕ 发现的定义 ⊕ 外部 runner（docs/history/wave5-plan.md §7.1–§7.3、§7.6）。[W5-G]
 *
 * - 发现的同名定义覆盖内置类型（不 warning）；外部 runner（W5-E 的 ProcessRunner、宿主 runner）以
 *   `add()` 登记，名字已存在时保留先登记者。
 * - `describe()`：task 工具描述里的类型清单，总预算约 400 token（1 600 字符），超出只列名字。
 * - `resolveModel()`：调用参数 `model` > 定义 `model`（非 inherit）> config `agents.<name>.model` >
 *   `subagents.defaultModel` > 父当前模型（返回 undefined）；`fast` / `strong` 经 `models.aliases`。
 */

import { agentEntry, type AgentsConfig, type ModelsConfig } from "../config/types-w5.js";
import { BUILTIN_AGENTS } from "./builtin.js";
import type { AgentDefinition, AgentInfo } from "./types.js";

export const AGENT_LIST_BUDGET_CHARS = 1600;

export interface AgentModelConfig {
  agents?: AgentsConfig;
  subagents?: { defaultModel?: string; forkMaxContextRatio?: number };
  models?: ModelsConfig;
}

export class AgentCatalog {
  private readonly byName = new Map<string, AgentDefinition>();
  private resolver: ((name: string) => AgentDefinition | undefined) | undefined;

  constructor(discovered: readonly AgentDefinition[] = []) {
    for (const agent of BUILTIN_AGENTS) this.byName.set(agent.name, agent);
    for (const agent of discovered) this.byName.set(agent.name, agent);
  }

  /**
   * 目录里没有的名字按需解析（`acp:<program>`、未在启动时登记的外部 / 宿主 runner，见
   * agents/external.ts）。解析出的类型不进 {@link describe}：task 工具描述在会话内保持字节不变。
   */
  setResolver(resolver: ((name: string) => AgentDefinition | undefined) | undefined): void {
    this.resolver = resolver;
  }

  get(name: string): AgentDefinition | undefined {
    return this.byName.get(name) ?? this.resolver?.(name);
  }

  /** 外部 / 宿主类型；同名已存在返回 false。 */
  add(agent: AgentDefinition): boolean {
    if (this.byName.has(agent.name)) return false;
    this.byName.set(agent.name, agent);
    return true;
  }

  list(): AgentDefinition[] {
    return [...this.byName.values()];
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  infos(): AgentInfo[] {
    return this.list().map((agent) => {
      const info: AgentInfo = {
        name: agent.name,
        description: agent.description,
        runner: agent.runner,
        source: agent.source,
      };
      if (agent.filePath !== undefined) info.filePath = agent.filePath;
      return info;
    });
  }

  /** task 工具描述里的类型清单（`- name: description`；超预算只列名字）。 */
  describe(budget = AGENT_LIST_BUDGET_CHARS): string {
    const lines = this.list().map((agent) => `- ${agent.name}: ${agent.description}`);
    const full = lines.join("\n");
    if (full.length <= budget) return full;
    return this.names().join(", ");
  }
}

export interface ResolvedAgentModel {
  /** `provider/model[@channel]`；undefined = 继承父当前模型。 */
  ref?: string;
  warning?: string;
}

export function resolveAgentModel(
  agent: AgentDefinition,
  requested: string | undefined,
  config: AgentModelConfig,
): ResolvedAgentModel {
  const own = agent.model === "inherit" ? undefined : agent.model;
  const picked =
    requested ??
    own ??
    agentEntry(config.agents, agent.name)?.model ??
    config.subagents?.defaultModel;
  if (picked === undefined || picked === "inherit") return {};
  if (picked === "fast" || picked === "strong") {
    const alias = config.models?.aliases?.[picked];
    if (alias === undefined)
      return { warning: `models.aliases.${picked} is not set; using the parent model` };
    return { ref: alias };
  }
  return { ref: picked };
}
