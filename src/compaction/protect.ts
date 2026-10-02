/**
 * 档一保护集（wave5 §8.2 C4）。[W5-H1]
 *
 * 不被档一换成占位的工具结果：
 * - `todo`、`skill` 工具的结果（任务清单与 Skill 正文是长任务的骨架）；
 * - `read` 读入的 Skill 文件（系统提示 skills 节 `<location>` 里列出的路径）与 `AGENTS.md` / `CLAUDE.md`；
 * - 声明了 `annotations.keepInContext` 的工具（宿主工具可用）；
 * - `compaction.pruneExclude` 列出的工具名。
 */

import { basename, resolve } from "node:path";
import type { ContextItem } from "../session/projection.js";
import type { PruneCandidate } from "./prune-tier.js";

export const PROTECTED_TOOLS: readonly string[] = ["todo", "skill"];
export const PROTECTED_FILE_NAMES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

export interface ProtectionInput {
  cwd: string;
  /** Skill 文件的绝对路径（见 `skillLocations`）。 */
  skillPaths?: readonly string[];
  /** `compaction.pruneExclude`。 */
  exclude?: readonly string[];
  /** 工具是否声明了 `annotations.keepInContext`。 */
  keepInContext?(toolName: string): boolean;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 投影里最近一次给出 skills 节的 system 消息中的 `<location>`（索引里列出的 Skill 文件）。 */
export function skillLocations(items: readonly ContextItem[]): string[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const message = items[i]?.message;
    if (message?.role !== "system") continue;
    const section = message.sections["skills"];
    if (section === undefined) continue; // 补丁里没改这一节，往前找
    if (section === null) return []; // 这一节被移除
    return [...section.matchAll(/<location>([^<]*)<\/location>/g)].map((m) =>
      unescapeXml(m[1] ?? "").trim(),
    );
  }
  return [];
}

/** `read` 调用读的文件（绝对路径）；不是 read 或缺 path 时 undefined。 */
export function readPathOf(
  candidate: Pick<PruneCandidate, "toolName" | "args">,
  cwd: string,
): string | undefined {
  if (candidate.toolName !== "read") return undefined;
  const path = candidate.args?.["path"];
  return typeof path === "string" && path !== "" ? resolve(cwd, path) : undefined;
}

export function createProtection(input: ProtectionInput): (candidate: PruneCandidate) => boolean {
  const tools = new Set([...PROTECTED_TOOLS, ...(input.exclude ?? [])]);
  const skills = new Set((input.skillPaths ?? []).map((path) => resolve(input.cwd, path)));
  return (candidate) => {
    if (tools.has(candidate.toolName)) return true;
    if (input.keepInContext?.(candidate.toolName) === true) return true;
    const path = readPathOf(candidate, input.cwd);
    if (path === undefined) return false;
    return skills.has(path) || PROTECTED_FILE_NAMES.includes(basename(path));
  };
}
