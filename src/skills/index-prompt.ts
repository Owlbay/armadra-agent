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
    how =
      "Call the skill tool with a skill's name to load it when the task matches its description.";
  } else if (options.hasReadTool) {
    how = "Use the read tool to load a skill's file when the task matches its description.";
  } else {
    return "";
  }
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    how,
    "When a skill file references a relative path, resolve it against the skill's directory.",
    "",
    "<available_skills>",
  ];
  for (const s of visible) {
    lines.push(
      "  <skill>",
      `    <name>${escapeXml(s.name)}</name>`,
      `    <description>${escapeXml(s.description)}</description>`,
      `    <location>${escapeXml(s.location)}</location>`,
      "  </skill>",
    );
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
