/**
 * `/skill:<name> [args]` 展开（设计 §5.3）。[B3]
 *
 * 展开格式：
 *   <skill name="…" location="…">
 *   References are relative to <dir>.
 *
 *   <正文（去掉 frontmatter）>
 *   </skill>
 *
 *   <args>          ← 有参数时才有
 * 用户手打的 `/skill:` 不受 `disable-model-invocation` 限制（那只约束模型调用）。
 */

import { readFile } from "node:fs/promises";
import type { Skill } from "./discover.js";
import { splitFrontmatter } from "./frontmatter.js";
import { escapeXml } from "./index-prompt.js";

export const SKILL_COMMAND_PREFIX = "/skill:";

export interface SkillCommand {
  name: string;
  args: string;
}

export function parseSkillCommand(text: string): SkillCommand | undefined {
  const m = /^\/skill:([a-z0-9-]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1] as string, args: (m[2] ?? "").trim() };
}

export function skillBody(fileText: string): string {
  return splitFrontmatter(fileText).body.replace(/^\n+/, "").replace(/\s+$/, "");
}

/** `<skill …>` 块（skill 工具与 `/skill:` 共用）。 */
export function formatSkillBlock(
  skill: Pick<Skill, "name" | "location" | "baseDir">,
  body: string,
): string {
  return (
    `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.location)}">\n` +
    `References are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  );
}

export function formatSkillInvocation(
  skill: Pick<Skill, "name" | "location" | "baseDir">,
  body: string,
  args: string,
): string {
  const block = formatSkillBlock(skill, body);
  return args === "" ? block : `${block}\n\n${args}`;
}

export type SkillExpansion =
  | { kind: "expanded"; text: string; skill: Skill }
  | { kind: "unknown"; name: string; available: string[] };

/** 不是 `/skill:` 命令返回 undefined。 */
export async function expandSkillCommand(
  text: string,
  skills: readonly Skill[],
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<SkillExpansion | undefined> {
  const cmd = parseSkillCommand(text);
  if (!cmd) return undefined;
  const skill = skills.find((s) => s.name === cmd.name);
  if (!skill) return { kind: "unknown", name: cmd.name, available: skills.map((s) => s.name) };
  const body = skillBody(await read(skill.location));
  return { kind: "expanded", text: formatSkillInvocation(skill, body, cmd.args), skill };
}
