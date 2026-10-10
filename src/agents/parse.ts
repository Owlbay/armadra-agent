/**
 * 子 Agent 定义文件解析（docs/history/wave5-plan.md §7.1，D22）。[W5-G]
 *
 * 一个 `*.md` = 一个类型：frontmatter 与 Skill 同一套 YAML 子集（skills/frontmatter.ts），字段名
 * kebab-case；正文 = 追加到子会话系统提示末尾的角色说明。不合格的文件不加载并给出 warning（拼错的
 * 字段比静默按缺省运行更容易发现）。不支持的字段（`hooks`、`mcpServers`、`memory`、`color`、
 * `initialPrompt`、`skills`）与未知字段忽略。
 */

import { basename } from "node:path";
import type { ModelThinkingLevel } from "../ai/types.js";
import { parseFrontmatter, type FrontmatterValue } from "../skills/frontmatter.js";
import type { AgentDefinition, AgentRunnerSpec, AgentSource } from "./types.js";

export const AGENT_NAME_RE = /^[a-z0-9-]{1,64}$/;
export const MAX_AGENT_DESCRIPTION = 1024;
export const DEFAULT_AGENT_MAX_TURNS = 30;
const THINKING: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** 字符串或数组 → 名字列表（`read, grep` / `[read, grep]` / 块数组）。 */
function nameList(value: FrontmatterValue | undefined): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const items = Array.isArray(value) ? value.map(String) : String(value).split(/[\s,]+/);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

function isRunner(value: string): value is AgentRunnerSpec {
  return value === "ama" || value === "claude" || value === "codex" || /^acp:[^\s]+$/.test(value);
}

function permissionModeOf(value: FrontmatterValue | undefined): "plan" | "inherit" | undefined {
  if (value === undefined || value === null) return "inherit";
  const text = String(value).trim();
  if (text === "inherit") return "inherit";
  // R4 草案写作 read-only；与 plan 同义（D22：只读复用 plan 模式）
  if (text === "plan" || text === "read-only" || text === "readonly") return "plan";
  return undefined;
}

export interface ParsedAgent {
  agent?: AgentDefinition;
  warnings: string[];
}

/** 解析一份定义文件；`filePath` 用于缺省名与 warning。 */
export function parseAgentDefinition(
  text: string,
  filePath: string,
  source: AgentSource,
): ParsedAgent {
  const warnings: string[] = [];
  const fail = (message: string): ParsedAgent => {
    warnings.push(`${filePath}: ${message}`);
    return { warnings };
  };
  const fm = parseFrontmatter(text);
  for (const error of fm.errors) warnings.push(`${filePath}: ${error}`);
  const data = fm.data;
  const rawName = data["name"];
  const name = typeof rawName === "string" && rawName !== "" ? rawName : basename(filePath, ".md");
  if (!AGENT_NAME_RE.test(name))
    return fail(`invalid agent name "${name}" (lowercase letters, digits, -; at most 64)`);
  const description = data["description"];
  if (typeof description !== "string" || description.trim() === "")
    return fail(`missing description; agent "${name}" not loaded`);
  if (description.length > MAX_AGENT_DESCRIPTION)
    return fail(`description longer than ${MAX_AGENT_DESCRIPTION} characters`);

  const runnerRaw = data["runner"] ?? "ama";
  const runner = String(runnerRaw).trim();
  if (!isRunner(runner))
    return fail(`unknown runner "${runner}" (ama | claude | codex | acp:<program>)`);
  const tools = nameList(data["tools"]);
  const disallowedTools = nameList(data["disallowed-tools"]);
  if (tools !== undefined && disallowedTools !== undefined)
    return fail("tools and disallowed-tools are mutually exclusive");
  const permissionMode = permissionModeOf(data["permission-mode"]);
  if (permissionMode === undefined)
    return fail(
      `permission-mode must be plan or inherit (got "${String(data["permission-mode"])}")`,
    );
  const model = data["model"] === undefined || data["model"] === null ? "inherit" : data["model"];
  if (typeof model !== "string" || model.trim() === "") return fail("model must be a string");
  const thinking = data["thinking"];
  if (
    thinking !== undefined &&
    thinking !== null &&
    !THINKING.includes(thinking as ModelThinkingLevel)
  )
    return fail(`thinking must be one of ${THINKING.join(", ")}`);
  const maxTurns = data["max-turns"] ?? DEFAULT_AGENT_MAX_TURNS;
  if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)
    return fail("max-turns must be an integer ≥ 1");
  const isolation = data["isolation"] ?? "none";
  if (isolation !== "none" && isolation !== "worktree")
    return fail("isolation must be none or worktree");
  const background = data["background"];
  if (background !== undefined && typeof background !== "boolean")
    return fail("background must be true or false");
  const context = data["context"];
  if (context !== undefined && context !== null && context !== "fork" && context !== "fresh")
    return fail("context must be fork or fresh");

  if (runner !== "ama") {
    const ignored = ["tools", "disallowed-tools", "permission-mode", "context"].filter(
      (key) => data[key] !== undefined,
    );
    if (ignored.length > 0)
      warnings.push(
        `${filePath}: ${ignored.join(", ")} ignored for external runner ${runner} (it keeps its own policy)`,
      );
  }
  const agent: AgentDefinition = {
    name,
    description: description.trim(),
    permissionMode,
    model: model.trim(),
    maxTurns,
    isolation,
    runner,
    prompt: fm.body.trim(),
    source,
    filePath,
  };
  if (background !== undefined) agent.background = background;
  if (tools !== undefined) agent.tools = tools;
  if (disallowedTools !== undefined) agent.disallowedTools = disallowedTools;
  if (typeof thinking === "string") agent.thinking = thinking as ModelThinkingLevel;
  if (context === "fork" || context === "fresh") agent.context = context;
  return { agent, warnings };
}
