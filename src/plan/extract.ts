/**
 * `<proposed_plan>` 块的提取与步骤解析（docs/wave5-plan.md §6.3、D19）。[W5-F] 纯函数。
 *
 * - 只认开、闭标签**各占一行**（允许行首尾空白）、且不在代码围栏（``` / ~~~）内的块；
 *   不闭合的块忽略；多个完整块取最后一个。
 * - 步骤：优先 `- [ ] S1 …` 清单（任意位置的顶层清单项）；没有清单时取「步骤 / Steps」小节里的
 *   编号列表（没有该小节则取全部顶层编号列表）。行内标注 `[depends: S1, S2]`、`[agent: codex]`
 *   解析进 `dependsOn` / `agent` 并从文字里去掉。上限 {@link MAX_PLAN_STEPS} 条，超出截断。
 */

import type { PlanStep } from "../agent/types.js";

export const PLAN_OPEN_TAG = "<proposed_plan>";
export const PLAN_CLOSE_TAG = "</proposed_plan>";
export const MAX_PLAN_STEPS = 30;

export interface ExtractedPlan {
  /** 块内正文（不含标签），首尾空行去掉。 */
  markdown: string;
  steps: PlanStep[];
  /** 步骤超过上限被截断。 */
  truncated?: boolean;
}

const FENCE = /^\s*(```|~~~)/;

/** 从一条回复里取最后一个完整的 `<proposed_plan>` 块；没有返回 undefined。 */
export function extractProposedPlan(text: string): ExtractedPlan | undefined {
  const lines = text.split(/\r?\n/);
  let fence: string | undefined;
  let open: number | undefined;
  let last: { from: number; to: number } | undefined;
  for (const [i, line] of lines.entries()) {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const trimmed = line.trim();
    if (trimmed === PLAN_OPEN_TAG) open = i;
    else if (trimmed === PLAN_CLOSE_TAG && open !== undefined) {
      last = { from: open + 1, to: i };
      open = undefined;
    }
  }
  if (last === undefined) return undefined;
  const markdown = trimBlankLines(lines.slice(last.from, last.to)).join("\n");
  if (markdown.trim() === "") return undefined;
  return planFromMarkdown(markdown);
}

/** 计划正文 → 步骤（用户编辑过的全文、「把上一条回复当作计划」也走这里）。 */
export function planFromMarkdown(markdown: string): ExtractedPlan {
  const parsed = parsePlanSteps(markdown);
  const plan: ExtractedPlan = { markdown, steps: parsed.steps };
  if (parsed.truncated) plan.truncated = true;
  return plan;
}

function trimBlankLines(lines: string[]): string[] {
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from]!.trim() === "") from++;
  while (to > from && lines[to - 1]!.trim() === "") to--;
  return lines.slice(from, to);
}

const CHECKBOX = /^ {0,1}[-*+]\s+\[[ xX~]\]\s+(.+)$/;
const NUMBERED = /^ {0,1}(\d{1,3})[.)]\s+(.+)$/;
const STEP_ID = /^(S\d{1,3})\b[.:)]?\s*/;
const HEADING = /^#{1,6}\s+(.*)$/;
const STEPS_HEADING = /步骤|steps|implementation|实施|执行/i;

/** 计划正文里的步骤；没有可识别的列表返回空数组。 */
export function parsePlanSteps(markdown: string): { steps: PlanStep[]; truncated: boolean } {
  const lines = markdown.split(/\r?\n/);
  const outside = linesOutsideFences(lines);
  const checkbox = outside.flatMap((line) => {
    const m = CHECKBOX.exec(line);
    return m === null ? [] : [m[1]!];
  });
  let raw: { id?: string; text: string }[];
  if (checkbox.length > 0) {
    raw = checkbox.map(splitId);
  } else {
    const section = stepsSection(outside);
    raw = section.flatMap((line) => {
      const m = NUMBERED.exec(line);
      if (m === null) return [];
      const item = splitId(m[2]!);
      return [{ id: item.id ?? `S${m[1]!}`, text: item.text }];
    });
  }
  const truncated = raw.length > MAX_PLAN_STEPS;
  const seen = new Set<string>();
  const steps = raw.slice(0, MAX_PLAN_STEPS).map((item, i) => {
    let id = item.id ?? `S${i + 1}`;
    if (seen.has(id)) id = `S${i + 1}`;
    while (seen.has(id)) id = `${id}'`;
    seen.add(id);
    return annotate(id, item.text);
  });
  return { steps, truncated };
}

function linesOutsideFences(lines: readonly string[]): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker === fence) fence = undefined;
      continue;
    }
    if (fence === undefined) out.push(line);
  }
  return out;
}

/** 「步骤 / Steps」小节的行；没有该小节返回全部行。 */
function stepsSection(lines: readonly string[]): readonly string[] {
  const start = lines.findIndex((line) => {
    const m = HEADING.exec(line.trim());
    return m !== null && STEPS_HEADING.test(m[1]!);
  });
  if (start < 0) return lines;
  const level = (/^#+/.exec(lines[start]!.trim())?.[0] ?? "#").length;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^(#+)\s/.exec(line.trim());
    if (m !== null && m[1]!.length <= level) break;
    out.push(line);
  }
  return out;
}

function splitId(text: string): { id?: string; text: string } {
  const m = STEP_ID.exec(text.trim());
  return m === null ? { text: text.trim() } : { id: m[1]!, text: text.trim().slice(m[0].length) };
}

const ANNOTATION = /\[(depends|agent)\s*:\s*([^\]]*)\]/gi;

function annotate(id: string, text: string): PlanStep {
  const step: PlanStep = { id, text: "" };
  const cleaned = text.replace(ANNOTATION, (_all, key: string, value: string) => {
    if (key.toLowerCase() === "depends") {
      const ids = value
        .split(/[,，\s]+/)
        .map((v) => v.trim())
        .filter((v) => v !== "");
      if (ids.length > 0) step.dependsOn = ids;
    } else if (value.trim() !== "") step.agent = value.trim();
    return "";
  });
  step.text = cleaned.replace(/\s{2,}/g, " ").trim() || id;
  return step;
}
