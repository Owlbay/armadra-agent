/**
 * `edit` 工具（设计 §5.2）。[B3]
 *
 * - 每处 `oldText` 都在**原文**上匹配，必须唯一（`replaceAll` 例外）且互不重叠；
 * - 先精确匹配；任一处精确匹配失败则整批转入模糊空间（edit-fuzzy.ts），只改写被触及的行；
 * - 不唯一 → 错误里给出现次数与首两处行号；
 * - 保留 BOM 与 CRLF；要求先 read；`details.diff` 是统一 diff（给 TUI）。
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";
import { withFileMutex } from "./file-mutex.js";
import {
  applyPreservingLines,
  applyReplacements,
  detectLineEnding,
  findAll,
  lineNumberAt,
  normalizeForFuzzy,
  normalizeToLF,
  restoreLineEndings,
  splitBom,
  type Replacement,
} from "./edit-fuzzy.js";

export interface EditOp {
  oldText: string;
  newText: string;
}

export interface EditInput {
  path: string;
  edits: EditOp[];
  replaceAll?: boolean;
}

export interface EditDetails {
  path: string;
  diff: string;
  replacements: number;
  fuzzy: boolean;
  firstChangedLine: number;
}

export class EditError extends Error {}

export interface EditPlan {
  result: string;
  replacements: number;
  fuzzy: boolean;
}

function label(index: number, total: number): string {
  return total === 1 ? "oldText" : `edits[${index}].oldText`;
}

/** 在 LF 归一后的内容上计算替换结果；失败抛 EditError。 */
export function planEdits(content: string, edits: readonly EditOp[], replaceAll = false): EditPlan {
  if (edits.length === 0) throw new EditError("edits must contain at least one item");
  const ops = edits.map((e, i) => {
    if (typeof e.oldText !== "string" || typeof e.newText !== "string") {
      throw new EditError(`edits[${i}] needs string oldText and newText`);
    }
    if (e.oldText === "") throw new EditError(`${label(i, edits.length)} must not be empty`);
    return { oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText) };
  });

  const fuzzy = ops.some((op) => !content.includes(op.oldText));
  const base = fuzzy ? normalizeForFuzzy(content) : content;
  const reps: (Replacement & { edit: number })[] = [];
  ops.forEach((op, i) => {
    const needle = fuzzy ? normalizeForFuzzy(op.oldText) : op.oldText;
    const hits = needle === "" ? [] : findAll(base, needle);
    if (hits.length === 0) {
      throw new EditError(
        `Could not find ${label(i, ops.length)} in the file. It must match the current content ` +
          "exactly, including whitespace and line breaks.",
      );
    }
    if (hits.length > 1 && !replaceAll) {
      const lines = hits.slice(0, 2).map((h) => lineNumberAt(base, h));
      throw new EditError(
        `${label(i, ops.length)} matches ${hits.length} times (first at lines ${lines.join(" and ")}). ` +
          "Add surrounding context to make it unique, or set replaceAll.",
      );
    }
    for (const index of replaceAll ? hits : hits.slice(0, 1)) {
      reps.push({ index, length: needle.length, newText: op.newText, edit: i });
    }
  });

  const sorted = [...reps].sort((a, b) => a.index - b.index);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as (typeof sorted)[number];
    const cur = sorted[i] as (typeof sorted)[number];
    if (prev.index + prev.length > cur.index) {
      throw new EditError(
        `edits[${prev.edit}] and edits[${cur.edit}] overlap; merge them into a single edit`,
      );
    }
  }
  const result = fuzzy ? applyPreservingLines(content, base, reps) : applyReplacements(base, reps);
  if (result === content) throw new EditError("The edits produced no change to the file");
  return { result, replacements: reps.length, fuzzy };
}

// ---------------------------------------------------------------------------
// 统一 diff
// ---------------------------------------------------------------------------

type Op = { kind: " " | "-" | "+"; text: string; a: number; b: number };

function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: " ", text: a[i] as string, a: i, b: i });
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length * bm.length <= 4_000_000) {
    // LCS 动态规划（中段通常很小）。
    const w = bm.length + 1;
    const dp = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        dp[i * w + j] =
          am[i] === bm[j]
            ? (dp[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) {
        ops.push({ kind: " ", text: am[i] as string, a: pre + i, b: pre + j });
        i++;
        j++;
      } else if (
        i < am.length &&
        (j >= bm.length || (dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0))
      ) {
        ops.push({ kind: "-", text: am[i] as string, a: pre + i, b: pre + j });
        i++;
      } else {
        ops.push({ kind: "+", text: bm[j] as string, a: pre + i, b: pre + j });
        j++;
      }
    }
  } else {
    am.forEach((t, i) => ops.push({ kind: "-", text: t, a: pre + i, b: pre }));
    bm.forEach((t, j) => ops.push({ kind: "+", text: t, a: pre + am.length, b: pre + j }));
  }
  for (let k = 0; k < suf; k++) {
    const ai = a.length - suf + k;
    ops.push({ kind: " ", text: a[ai] as string, a: ai, b: b.length - suf + k });
  }
  return ops;
}

function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 统一 diff（LF 文本，3 行上下文）；无差异返回空串。 */
export function unifiedDiff(oldText: string, newText: string, path: string, context = 3): string {
  const ops = diffOps(toLines(oldText), toLines(newText));
  const changed = ops.map((op, i) => (op.kind === " " ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return "";
  const hunks: { start: number; end: number }[] = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length, idx + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    const slice = ops.slice(h.start, h.end);
    const first = slice[0] as Op;
    const aCount = slice.filter((o) => o.kind !== "+").length;
    const bCount = slice.filter((o) => o.kind !== "-").length;
    const aStart = aCount === 0 ? first.a : first.a + 1;
    const bStart = bCount === 0 ? first.b : first.b + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) out.push(`${o.kind}${o.text}`);
  }
  return out.join("\n");
}

function firstChangedLine(oldText: string, newText: string): number {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i + 1;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 检查点：写前备份（docs/rewind-plan.md §2）；钩子按约定不抛，这里再兜一层，不让编辑失败。 */
export async function beforeWrite(ctx: ToolContext, abs: string): Promise<void> {
  if (ctx.checkpoint === undefined) return;
  try {
    await ctx.checkpoint.beforeWrite(abs);
  } catch (error) {
    ctx.log("warn", `checkpoint: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function executeEdit(input: EditInput, ctx: ToolContext): Promise<ToolResult> {
  const abs = resolvePath(input.path, ctx.cwd);
  const shown = displayPath(abs, ctx.cwd);
  return withFileMutex(abs, async () => {
    try {
      const info = await stat(abs);
      if (!info.isFile()) return { content: `${shown} is not a regular file`, isError: true };
    } catch {
      return { content: `File not found: ${shown}`, isError: true };
    }
    if (!ctx.readFiles.has(abs)) {
      return { content: `Read ${shown} with the read tool before editing it.`, isError: true };
    }
    const raw = await readFile(abs, "utf8");
    const { bom, text } = splitBom(raw);
    const ending = detectLineEnding(text);
    const content = normalizeToLF(text);
    let plan: EditPlan;
    try {
      plan = planEdits(content, input.edits ?? [], input.replaceAll === true);
    } catch (err) {
      if (err instanceof EditError) return { content: `${shown}: ${err.message}`, isError: true };
      throw err;
    }
    const output = bom + restoreLineEndings(plan.result, ending);
    await beforeWrite(ctx, abs);
    await writeFile(abs, output, "utf8");
    ctx.checkpoint?.afterWrite(abs, output);
    const details: EditDetails = {
      path: abs,
      diff: unifiedDiff(content, plan.result, shown),
      replacements: plan.replacements,
      fuzzy: plan.fuzzy,
      firstChangedLine: firstChangedLine(content, plan.result),
    };
    const note = plan.fuzzy ? " (matched after whitespace/quote normalization)" : "";
    const count = `${plan.replacements} replacement${plan.replacements === 1 ? "" : "s"}`;
    return { content: `Edited ${shown}: ${count}${note}`, details };
  });
}

export function createEditTool(): ToolDefinition<EditInput> {
  return {
    name: "edit",
    label: "Edit",
    description:
      "Replace text in a file (read it first). Each oldText must be unique in the original " +
      "(unless replaceAll); edits must not overlap.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to replace" },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    permission: "write",
    executionMode: "sequential",
    annotations: { destructive: true },
    promptSnippet: "edit: replace text in a file",
    execute: executeEdit,
  };
}
