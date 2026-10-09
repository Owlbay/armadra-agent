/**
 * 子 Agent 定义契约（docs/wave5-plan.md §7.1–§7.2，D22）。[W5-C0] 契约文件，发现与解析归 W5-G。
 *
 * 定义文件：`--agent-dir`（可重复）→ profile `agentDirs` → `~/.config/ama/agents/*.md` →
 * `<cwd>/.ama/agents/*.md`（需信任）；frontmatter 与 Skill 同风格（kebab-case），正文追加到子会话
 * 系统提示末尾。这里是解析后（缺省已补齐）的形状。
 */

import type { ModelThinkingLevel } from "../ai/types.js";

/** `ama`（缺省）| `claude` | `codex` | `acp:<program>`。 */
export type AgentRunnerSpec = "ama" | "claude" | "codex" | `acp:${string}`;

export type AgentSource = "builtin" | "cli" | "profile" | "user" | "project" | "host";

export interface AgentDefinition {
  /** `^[a-z0-9-]{1,64}$`，缺省取文件名。 */
  name: string;
  /** ≤ 1024 字符，进 task 工具描述。 */
  description: string;
  /** 工具白名单（与 `disallowedTools` 二选一）；缺省 = 父活动集。 */
  tools?: string[];
  disallowedTools?: string[];
  /** `plan` 强制只读；`inherit` = 父当前模式（只能更严）。 */
  permissionMode: "plan" | "inherit";
  /** `inherit` | `fast` | `strong`（`models.aliases`）| `provider/model[@channel]`。 */
  model: string;
  thinking?: ModelThinkingLevel;
  /** 缺省 30。 */
  maxTurns: number;
  isolation: "none" | "worktree";
  /**
   * 显式覆盖缺省前台 / 后台；不设由 `subagents.background` 决定（[W7-B1]，优先级：调用参数 > 类型
   * 定义 > 配置）。
   */
  background?: boolean;
  runner: AgentRunnerSpec;
  /** [ME-C0] frontmatter `context:`：`fork` 继承父会话已完成的回合；缺省 `fresh`。 */
  context?: "fork" | "fresh";
  /** 正文：追加到子会话系统提示末尾的角色说明。 */
  prompt: string;
  source: AgentSource;
  /** 定义文件路径（内置与宿主类型没有）。 */
  filePath?: string;
}

/** RPC `get_agents` / `/agents` 的一行。 */
export interface AgentInfo {
  name: string;
  description: string;
  runner: AgentRunnerSpec | (string & {});
  source: AgentSource;
  filePath?: string;
  /** 外部 Agent：探测到的版本与是否已安装。 */
  installed?: boolean;
  version?: string;
}
