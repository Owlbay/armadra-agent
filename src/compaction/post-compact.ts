/**
 * 压缩后回注（wave5 §8.2 C6，D26）。[W5-H1]
 *
 * 把压缩可能丢掉的关键状态以**清单与指针**放回上下文（不含文件正文）：
 * - todo 快照（分支上最近一条 `ama.todo`）；
 * - 当前计划（最近一条未被拒绝 / 取代的 `ama.plan`：编号、状态、文件路径与步骤标题）；
 * - 已加载的 Skill（用 `read` 读过的索引路径，或 `skill` 工具的调用）；
 * - 最近修改 / 读取的文件路径（按最近使用排序，各至多 20 个）；
 * - [W6-M] 本会话读写过的记忆路径（`memory` 工具的 `/memories/…` 逻辑路径，只给路径不给正文）；
 * - 完整转录与 `outputs/` 路径（模型需要细节时自己 `read`）；
 * - 续接说明。
 *
 * 放在哪：作为 `<post-compact-state>` 块接在 compaction 条目的 `summary` 末尾（与已有的
 * `<read-files>` / `<modified-files>` 同一做法），模型看到的顺序就是「摘要 → 回注 → 保留区」。
 * 不另写 `custom_message`：投影把 compaction 之后的条目放在保留区之后，溢出恢复时保留区以用户刚发
 * 的提示结尾，追加在末尾的回注会排在那条提示后面、让模型先回应回注。压缩后本来就是新前缀，
 * 回注不额外打断缓存。下一次增量摘要前先剥掉这个块（`stripPostCompact`），每次重新生成。
 */

import { resolve } from "node:path";
import type { SessionEntry } from "../session/types.js";
import { TODO_CUSTOM_TYPE } from "../tools/todo.js";

export const POST_COMPACT_TAG = "post-compact-state";
export const PLAN_CUSTOM_TYPE = "ama.plan";
export const MAX_RECENT_FILES = 20;
const MAX_PLAN_STEPS = 20;
const MAX_LINE = 160;

const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export interface PostCompactInput {
  /** 活动分支（含刚追加的 compaction）。 */
  branch: readonly SessionEntry[];
  cwd: string;
  /** Skill 索引里的文件路径（`skillLocations`）。 */
  skillPaths?: readonly string[];
  /** 会话转录文件；内存会话 undefined。 */
  transcriptPath?: string | undefined;
  /** 裁剪 / 截断全文目录。 */
  outputDir?: string | undefined;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

function lastCustom(
  branch: readonly SessionEntry[],
  type: string,
  accept?: (data: unknown) => boolean,
) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === type) {
      if (accept === undefined || accept(entry.data)) return entry.data;
    }
  }
  return undefined;
}

const TODO_MARK: Record<string, string> = { pending: "[ ]", in_progress: "[~]", done: "[x]" };

function todoLines(branch: readonly SessionEntry[]): string[] {
  const data = lastCustom(branch, TODO_CUSTOM_TYPE) as { items?: unknown } | undefined;
  const items = Array.isArray(data?.items) ? (data.items as Record<string, unknown>[]) : [];
  const lines: string[] = [];
  for (const item of items) {
    if (typeof item?.["text"] !== "string") continue;
    const mark = TODO_MARK[String(item["status"])] ?? "[ ]";
    lines.push(`${mark} ${String(item["id"] ?? "")}. ${clip(item["text"])}`);
  }
  return lines;
}

interface PlanLike {
  id?: unknown;
  version?: unknown;
  status?: unknown;
  filePath?: unknown;
  steps?: unknown;
}

function planBlock(branch: readonly SessionEntry[]): string | undefined {
  const plan = lastCustom(branch, PLAN_CUSTOM_TYPE) as PlanLike | undefined;
  if (plan === undefined || typeof plan !== "object" || plan === null) return undefined;
  if (plan.status === "rejected" || plan.status === "superseded") return undefined;
  const attrs = [`id="${String(plan.id ?? "")}"`];
  if (plan.version !== undefined) attrs.push(`version="${String(plan.version)}"`);
  if (plan.status !== undefined) attrs.push(`status="${String(plan.status)}"`);
  if (typeof plan.filePath === "string") attrs.push(`file="${plan.filePath}"`);
  const steps = Array.isArray(plan.steps) ? (plan.steps as Record<string, unknown>[]) : [];
  const lines = steps
    .slice(0, MAX_PLAN_STEPS)
    .map((step) => `${String(step?.["id"] ?? "")} ${clip(String(step?.["text"] ?? ""))}`);
  if (steps.length > MAX_PLAN_STEPS) lines.push(`(+${steps.length - MAX_PLAN_STEPS} more steps)`);
  return [`<plan ${attrs.join(" ")}>`, ...lines, "</plan>"].join("\n");
}

interface FileActivity {
  read: string[];
  modified: string[];
  skills: string[];
  memory: string[];
}

/** 按最近使用排序（最近的在前）的文件与 Skill。 */
function fileActivity(input: PostCompactInput): FileActivity {
  const skillSet = new Set((input.skillPaths ?? []).map((path) => resolve(input.cwd, path)));
  const read = new Map<string, number>();
  const modified = new Map<string, number>();
  const skills = new Map<string, number>();
  const memory = new Map<string, number>();
  let order = 0;
  for (const entry of input.branch) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall") continue;
      order++;
      if (block.name === "skill") {
        const name = block.arguments["name"];
        if (typeof name === "string") skills.set(name, order);
        continue;
      }
      const path = block.arguments["path"];
      if (typeof path !== "string" || path === "") continue;
      if (block.name === "memory") {
        if (path.startsWith("/memories/")) memory.set(clip(path), order);
        continue;
      }
      const abs = resolve(input.cwd, path);
      if (WRITE_TOOLS.has(block.name)) modified.set(path, order);
      else if (READ_TOOLS.has(block.name)) {
        if (skillSet.has(abs)) skills.set(abs, order);
        else read.set(path, order);
      }
    }
  }
  for (const path of modified.keys()) read.delete(path);
  const recent = (map: Map<string, number>): string[] =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  return {
    read: recent(read),
    modified: recent(modified),
    skills: recent(skills),
    memory: recent(memory),
  };
}

function capped(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_RECENT_FILES);
  const more = paths.length - shown.length;
  return more > 0 ? `${shown.join("\n")}\n(+${more} more)` : shown.join("\n");
}

const BLOCK_PATTERN = new RegExp(`\\s*<${POST_COMPACT_TAG}>[\\s\\S]*?</${POST_COMPACT_TAG}>`, "g");

/** 去掉摘要里的回注块（上一份摘要作增量合并的输入前、模型照抄进新摘要时）。 */
export function stripPostCompact(summary: string): string {
  return summary.replace(BLOCK_PATTERN, "").trimEnd();
}

/** 回注块（`<post-compact-state>…</post-compact-state>`）；无任何可回注的状态时仍给出续接说明。 */
export function buildPostCompactBlock(input: PostCompactInput): string {
  return `<${POST_COMPACT_TAG}>\n${buildPostCompactContent(input)}\n</${POST_COMPACT_TAG}>`;
}

/** 回注正文。 */
export function buildPostCompactContent(input: PostCompactInput): string {
  const parts = [
    "State to continue from after compaction (pointers only; read a file again only when you need its content):",
  ];
  const todo = todoLines(input.branch);
  if (todo.length > 0) parts.push(`<todo>\n${todo.join("\n")}\n</todo>`);
  const plan = planBlock(input.branch);
  if (plan !== undefined) parts.push(plan);
  const files = fileActivity(input);
  if (files.skills.length > 0)
    parts.push(`<loaded-skills>\n${capped(files.skills)}\n</loaded-skills>`);
  if (files.modified.length > 0)
    parts.push(`<recently-modified-files>\n${capped(files.modified)}\n</recently-modified-files>`);
  if (files.read.length > 0)
    parts.push(`<recently-read-files>\n${capped(files.read)}\n</recently-read-files>`);
  if (files.memory.length > 0)
    parts.push(`<memory-files>\n${capped(files.memory)}\n</memory-files>`);
  if (input.transcriptPath !== undefined)
    parts.push(
      `<transcript>${input.transcriptPath}</transcript> (full history before compaction, JSONL; read it only if the summary lacks a detail you need)`,
    );
  if (input.outputDir !== undefined)
    parts.push(
      `<outputs>${input.outputDir}</outputs> (full text of pruned and truncated tool results)`,
    );
  parts.push(
    "Continue from the summary's Next Steps and the todo list; do not redo finished work.",
  );
  return parts.join("\n\n");
}
