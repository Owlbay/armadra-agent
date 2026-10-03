/**
 * 系统提示 `rules` 节的通用行为规则（在各工具 `promptGuidelines` 之前）。
 *
 * 只按工具表决定、会话内不变，所以不影响前缀稳定（设计 §9.1）。每加一条都进每次请求的缓存前缀：
 * 保持一句、英文、只写模型确实会做错的事；预算见 `src/cli/prompt-budget.test.ts`。
 * 「edit 的多处修改」写在 edit 工具描述里（只在 edit 可用时出现）；并行批量在 codemode 独占时
 * 由它自己的说明负责，所以只在 read 直接可用时给。
 * 「先定位再读」只在 grep 与 glob 都直接可用时给（docs/search-plan.md §4.2：`minimal` 下模型会连猜文件名）。
 */

import type { ToolDefinition } from "../tools/types.js";

export const DESTRUCTIVE_RULE =
  "Ask before destructive commands (rm -rf, git reset --hard, force push, deleting branches) unless the user requested them.";

export const PARALLEL_READS_RULE = "Batch independent read-only tool calls into one turn.";

export const LOCATE_RULE = "Locate code with grep/glob before reading; do not guess file paths.";

export function baseRules(tools: readonly Pick<ToolDefinition, "name">[]): string[] {
  if (tools.length === 0) return [];
  const rules = [DESTRUCTIVE_RULE];
  const has = (name: string): boolean => tools.some((tool) => tool.name === name);
  if (has("read")) rules.push(PARALLEL_READS_RULE);
  if (has("grep") && has("glob")) rules.push(LOCATE_RULE);
  return rules;
}
