/**
 * 子 Agent 定义发现（docs/wave5-plan.md §7.1，D22）。[W5-G]
 *
 * 顺序：`--agent-dir`（可重复，profile `agentDirs` 由启动步骤并在其后）→ config `agents.dirs` →
 * `<configDir>/agents/*.md`（用户级）→ `<cwd>/.ama/agents/*.md`（项目级，需信任；未信任跳过并记入
 * `skippedUntrusted`）。每个来源目录只看直接下层的 `*.md`（按名排序）；同名先发现者胜并 warning。
 * 内置类型（builtin.ts）由 catalog.ts 合并，可被这里发现的同名定义覆盖。
 *
 * 同步实现：定义目录小而平，发现在会话装配时一次完成（compose-agents.ts）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentDefinition, AgentSource } from "./types.js";
import { parseAgentDefinition } from "./parse.js";

export interface AgentDirSource {
  dir: string;
  source: AgentSource;
  requiresTrust: boolean;
}

export interface AgentDirSources {
  cwd: string;
  /** 用户级配置目录（`~/.config/ama`）。 */
  configDir: string;
  /** `--agent-dir` 与 profile `agentDirs`（已按顺序合并）。 */
  cliDirs?: readonly string[];
  /** config `agents.dirs`。 */
  configDirs?: readonly string[];
}

export interface AgentDiscovery {
  agents: AgentDefinition[];
  warnings: string[];
  /** 因未信任而跳过的目录（存在的才列出）。 */
  skippedUntrusted: string[];
}

export function agentSources(options: AgentDirSources): AgentDirSource[] {
  const out: AgentDirSource[] = [];
  const add = (dir: string, source: AgentSource, requiresTrust: boolean) =>
    out.push({ dir: resolve(options.cwd, dir), source, requiresTrust });
  for (const dir of options.cliDirs ?? []) add(dir, "cli", false);
  for (const dir of options.configDirs ?? []) add(dir, "user", false);
  add(join(options.configDir, "agents"), "user", false);
  add(join(options.cwd, ".ama", "agents"), "project", true);
  return out;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function markdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export function discoverAgents(
  sources: readonly AgentDirSource[],
  options: { trusted: boolean },
): AgentDiscovery {
  const result: AgentDiscovery = { agents: [], warnings: [], skippedUntrusted: [] };
  const byName = new Map<string, AgentDefinition>();
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.dir)) continue;
    seen.add(source.dir);
    if (!isDir(source.dir)) continue;
    if (source.requiresTrust && !options.trusted) {
      result.skippedUntrusted.push(source.dir);
      continue;
    }
    for (const file of markdownFiles(source.dir)) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        result.warnings.push(`${file}: ${(error as Error).message}`);
        continue;
      }
      const parsed = parseAgentDefinition(text, file, source.source);
      result.warnings.push(...parsed.warnings);
      const agent = parsed.agent;
      if (agent === undefined) continue;
      const existing = byName.get(agent.name);
      if (existing !== undefined) {
        result.warnings.push(
          `${file}: agent "${agent.name}" already defined at ${existing.filePath ?? existing.source}; ignored`,
        );
        continue;
      }
      byName.set(agent.name, agent);
      result.agents.push(agent);
    }
  }
  return result;
}
