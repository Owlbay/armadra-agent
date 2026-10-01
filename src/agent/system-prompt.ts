/**
 * 系统提示的命名节装配与补丁 diff（设计 §1.2 system-prompt.ts、§9「缓存」）。[B2]
 *
 * 节顺序固定：preamble → tools → rules → project_context → skills → hooks → cwd → host
 * （`hooks` = SessionStart Hook 的 additionalContext；`host` = 宿主 instructions.add，最后）。
 * 不含时间戳等易变内容，保证前缀缓存稳定。
 *
 * 首次请求前，整份节 + 工具表作为首条 `system` 消息落盘；之后节或工具表变化时只落补丁
 * （节名级替换、`null` 删除；`toolsAdded` / `toolsRemoved`），请求时由协议层重装全量。
 */

import type { SystemMessage, ToolDecl } from "../ai/types.js";
import { replaySystem, type SystemState } from "../session/projection.js";
import type { AgentMessage } from "../session/types.js";
import type { ToolDefinition } from "../tools/types.js";

export const SECTION_ORDER = [
  "preamble",
  "tools",
  "rules",
  "project_context",
  "skills",
  "hooks",
  "cwd",
  "host",
] as const;

export type SectionName = (typeof SECTION_ORDER)[number];

export const DEFAULT_PREAMBLE =
  "You are ama, a coding agent working in the user's project through tools. Read files before " +
  "changing them, make focused changes, and verify your work. Be concise.";

export interface SystemPromptInput {
  preamble?: string;
  tools: readonly ToolDefinition[];
  extraRules?: readonly string[];
  contextFiles?: readonly { path: string; content: string }[];
  /** 预渲染的 `<available_skills>` 索引（B3 的 index-prompt.ts）；缺省时由 skills 列表生成最小索引。 */
  skillsIndex?: string;
  skills?: readonly { name: string; description: string; location: string }[];
  /** SessionStart Hook 的 additionalContext。 */
  hookContext?: string;
  cwd: string;
  /** 宿主 instructions（已读入的文本），按添加顺序。 */
  hostInstructions?: readonly string[];
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

export function toolDecl(tool: ToolDefinition): ToolDecl {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** 按名排序的工具声明（与 ToolRegistry.active() 的顺序一致）。 */
export function toolDecls(tools: readonly ToolDefinition[]): ToolDecl[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(toolDecl);
}

export function assembleSections(
  input: SystemPromptInput,
): Record<SectionName, string | undefined> {
  const tools = [...input.tools].sort((a, b) => a.name.localeCompare(b.name));
  const toolLines = tools.map(
    (tool) => `- ${tool.name}: ${tool.promptSnippet ?? firstLine(tool.description)}`,
  );
  const rules = [
    ...tools.flatMap((tool) => tool.promptGuidelines ?? []),
    ...(input.extraRules ?? []),
  ];
  const projectContext = (input.contextFiles ?? [])
    .map((file) => `<file path="${escapeXml(file.path)}">\n${file.content.trim()}\n</file>`)
    .join("\n\n");
  let skills = input.skillsIndex;
  if (skills === undefined && input.skills !== undefined && input.skills.length > 0) {
    skills = [
      "<available_skills>",
      ...input.skills.map(
        (skill) =>
          `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.location)}">${escapeXml(skill.description)}</skill>`,
      ),
      "</available_skills>",
    ].join("\n");
  }
  const host = (input.hostInstructions ?? []).map((text) => text.trim()).filter(Boolean);
  const nonEmpty = (text: string | undefined): string | undefined =>
    text === undefined || text.trim() === "" ? undefined : text;
  return {
    preamble: input.preamble ?? DEFAULT_PREAMBLE,
    tools: toolLines.length > 0 ? `Available tools:\n${toolLines.join("\n")}` : undefined,
    rules: rules.length > 0 ? `Rules:\n${rules.map((rule) => `- ${rule}`).join("\n")}` : undefined,
    project_context: nonEmpty(projectContext),
    skills: nonEmpty(skills),
    hooks: nonEmpty(input.hookContext),
    cwd: `Current working directory: ${input.cwd}`,
    host: host.length > 0 ? host.join("\n\n") : undefined,
  };
}

/** 去掉 undefined 的有序节表。 */
export function definedSections(
  sections: Record<SectionName, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SECTION_ORDER) {
    const text = sections[name];
    if (text !== undefined) out[name] = text;
  }
  return out;
}

export function currentSystemState(messages: Iterable<AgentMessage>): SystemState | undefined {
  return replaySystem(messages);
}

function sameTool(a: ToolDecl, b: ToolDecl): boolean {
  return (
    a.description === b.description && JSON.stringify(a.parameters) === JSON.stringify(b.parameters)
  );
}

/**
 * 当前状态 → 目标状态的 system 消息：无当前状态 → 全量；有差异 → 补丁；无差异 → undefined。
 */
export function diffSystem(
  current: SystemState | undefined,
  sections: Record<string, string>,
  tools: readonly ToolDecl[],
  timestamp = Date.now(),
): SystemMessage | undefined {
  if (current === undefined) {
    const full: SystemMessage = { role: "system", sections: { ...sections }, timestamp };
    if (tools.length > 0) full.toolsAdded = tools.map((tool) => ({ ...tool }));
    return full;
  }
  const patch: Record<string, string | null> = {};
  for (const [name, text] of Object.entries(sections)) {
    if (current.sections[name] !== text) patch[name] = text;
  }
  for (const name of Object.keys(current.sections)) {
    if (!(name in sections)) patch[name] = null;
  }
  const before = new Map(current.tools.map((tool) => [tool.name, tool]));
  const after = new Map(tools.map((tool) => [tool.name, tool]));
  const toolsAdded = tools.filter((tool) => {
    const old = before.get(tool.name);
    return old === undefined || !sameTool(old, tool);
  });
  const toolsRemoved = [...before.keys()].filter((name) => !after.has(name));
  if (Object.keys(patch).length === 0 && toolsAdded.length === 0 && toolsRemoved.length === 0) {
    return undefined;
  }
  const message: SystemMessage = { role: "system", sections: patch, timestamp };
  if (toolsAdded.length > 0) message.toolsAdded = toolsAdded.map((tool) => ({ ...tool }));
  if (toolsRemoved.length > 0) message.toolsRemoved = toolsRemoved;
  return message;
}
