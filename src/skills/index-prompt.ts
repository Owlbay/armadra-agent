/**
 * `<available_skills>` 索引（设计 §5.3 三级披露第一级）。[B3]
 *
 * 放进系统提示 `skills` 节。`disable-model-invocation: true` 的技能不进索引；有 `skill` 工具时
 * 引导用它，否则用 `read`，都没有时不生成索引（返回空串）。
 */

import type { Skill } from "./discover.js";

export interface SkillIndexOptions {
  hasSkillTool: boolean;
  hasReadTool: boolean;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatSkillIndex(
  skills: readonly Pick<Skill, "name" | "description" | "location" | "disableModelInvocation">[],
  options: SkillIndexOptions,
): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  let how: string;
  if (options.hasSkillTool) {
    how = "call the skill tool with its name";
  } else if (options.hasReadTool) {
    how = "read its file";
  } else {
    return "";
  }
  // 每个字都进缓存前缀（预算见 src/cli/prompt-budget.test.ts），说明保持一行。
  const lines = [
    `Skills: when a task matches one, ${how} first; resolve its relative paths against its directory.`,
    "<available_skills>",
  ];
  for (const s of visible) {
    lines.push(
      `<skill name="${escapeXml(s.name)}" location="${escapeXml(s.location)}">${escapeXml(s.description)}</skill>`,
    );
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
