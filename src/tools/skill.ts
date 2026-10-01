/**
 * `skill` 工具（设计 §5.2、§5.3 三级披露的模型侧入口）。[B3]
 *
 * 按名返回 SKILL.md 全文（`<skill name location>` 包裹，并说明相对路径的基准目录）；不存在 → 列出
 * 可用名；`disable-model-invocation: true` 的技能拒绝模型调用。技能列表由装配方（B5 发现结果）
 * 通过 `getSkills()` 提供，随时可变。
 */

import { readFile } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "./types.js";
import type { Skill } from "../skills/discover.js";
import { formatSkillBlock } from "../skills/expand.js";

export interface SkillInput {
  name: string;
}

export interface SkillToolOptions {
  getSkills(): readonly Skill[];
  /** 测试注入。 */
  readFile?(path: string): Promise<string>;
}

function available(skills: readonly Skill[]): string {
  const names = skills.filter((s) => !s.disableModelInvocation).map((s) => s.name);
  return names.length === 0 ? "No skills are available." : `Available skills: ${names.join(", ")}`;
}

export function createSkillTool(options: SkillToolOptions): ToolDefinition<SkillInput> {
  const read = options.readFile ?? ((p: string) => readFile(p, "utf8"));
  return {
    name: "skill",
    label: "Skill",
    description:
      "Load a skill's full instructions by name (see <available_skills> in the system prompt).",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name" } },
      required: ["name"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    annotations: { readOnly: true },
    promptSnippet: "skill: load a skill's instructions by name",
    async execute(input): Promise<ToolResult> {
      const skills = options.getSkills();
      const skill = skills.find((s) => s.name === input.name);
      if (!skill) {
        return { content: `Unknown skill "${input.name}". ${available(skills)}`, isError: true };
      }
      if (skill.disableModelInvocation) {
        return {
          content: `Skill "${skill.name}" can only be invoked by the user (/skill:${skill.name}).`,
          isError: true,
        };
      }
      let text: string;
      try {
        text = await read(skill.location);
      } catch (err) {
        return {
          content: `Cannot read ${skill.location}: ${(err as Error).message}`,
          isError: true,
        };
      }
      return {
        content: formatSkillBlock(skill, text.replace(/\s+$/, "")),
        details: { name: skill.name, location: skill.location },
      };
    },
  };
}
