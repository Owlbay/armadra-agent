/**
 * 回滚界面的文案（rewind-plan §4）：交互模式的列表 / 面板 / 通知与 line 模式 `/rewind` 共用。[RW-C]
 *
 * - 统计：`N 文件 +x −y`（列表徽标）、`将恢复 N 个文件 +x −y`（面板预览）；ASCII 模式减号用 `-`。
 * - 结果：`已恢复 N 个文件，跳过 M 个（冲突 1、符号链接 1）` / `没有文件被恢复…` / `代码没有变化`，
 *   之后最多 5 行跳过明细。
 * - git：HEAD 与记录不同时给两条命令（只显示，不执行）。
 * - 错误码 `busy / no_checkpoint / rewind_failed` 换成中文说明。
 */

import type { CodeRestoreResult, RewindResult, RewindSkipReason } from "../../checkpoints/types.js";
import { isAmaError } from "../../errors.js";

/** 明细最多列出的文件数。 */
export const REWIND_DETAIL_MAX = 5;

export const SKIP_REASON_TEXT: Readonly<Record<RewindSkipReason, string>> = {
  symlink: "符号链接",
  hardlink: "硬链接",
  not_regular: "不是普通文件",
  parent_moved: "父目录被移动",
  too_large: "文件过大未备份",
  backup_missing: "备份缺失",
};

/** 一行文本：空白压成一个空格，超长截断。 */
export function oneLine(text: string, max = 60, ellipsis = "…"): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - ellipsis.length)}${ellipsis}` : flat;
}

/** 将恢复 / 已恢复的文件数（恢复 + 删除）。 */
export function codeFileCount(code: CodeRestoreResult): number {
  return code.restored.length + code.deleted.length;
}

/** 有没有代码可恢复（含冲突文件）。 */
export function hasCodeChanges(code: CodeRestoreResult | undefined): boolean {
  return code !== undefined && codeFileCount(code) + code.conflicts.length > 0;
}

export function diffStat(code: CodeRestoreResult, ascii = false): string {
  return `+${code.insertions} ${ascii ? "-" : "−"}${code.deletions}`;
}

/** 列表高亮行右侧的徽标。 */
export function badgeText(code: CodeRestoreResult, ascii = false): string {
  if (!hasCodeChanges(code)) return "无代码改动";
  if (codeFileCount(code) === 0) return `冲突 ${code.conflicts.length} 个`;
  return `${codeFileCount(code)} 文件 ${diffStat(code, ascii)}`;
}

/** 面板里代码类选项的预览。 */
export function restorePreview(code: CodeRestoreResult, ascii = false): string {
  const conflicts = code.conflicts.length;
  if (codeFileCount(code) === 0) return `只有冲突文件 ${conflicts} 个（缺省跳过）`;
  const suffix = conflicts > 0 ? `，冲突 ${conflicts} 个` : "";
  return `将恢复 ${codeFileCount(code)} 个文件 ${diffStat(code, ascii)}${suffix}`;
}

/** [W6-C0] 跳过原因按码分组（不按文案前缀判断，文案会随界面语言变）。 */
type SkipCode = RewindSkipReason | "conflict" | "failed";

interface Skip {
  path: string;
  code: SkipCode;
  /** 明细里显示的原因（failed 带错误信息）。 */
  reason: string;
}

function skipLabel(code: SkipCode): string {
  return code === "conflict" ? "冲突" : code === "failed" ? "失败" : SKIP_REASON_TEXT[code];
}

function skips(code: CodeRestoreResult, overwrite: boolean): Skip[] {
  return [
    ...(overwrite
      ? []
      : code.conflicts.map((path) => ({
          path,
          code: "conflict" as const,
          reason: skipLabel("conflict"),
        }))),
    ...code.skipped.map((s) => ({ path: s.path, code: s.reason, reason: skipLabel(s.reason) })),
    ...code.failed.map((f) => ({
      path: f.path,
      code: "failed" as const,
      reason: `失败：${f.message}`,
    })),
  ];
}

function reasonCounts(list: readonly Skip[]): string {
  const counts = new Map<SkipCode, number>();
  for (const skip of list) counts.set(skip.code, (counts.get(skip.code) ?? 0) + 1);
  return [...counts].map(([code, n]) => `${skipLabel(code)} ${n}`).join("、");
}

/** 跳过明细（最多 5 行，其余计数）。 */
export function skipDetailLines(code: CodeRestoreResult, overwrite = false): string[] {
  const list = skips(code, overwrite);
  const lines = list.slice(0, REWIND_DETAIL_MAX).map((s) => `  ${s.path}：${s.reason}`);
  if (list.length > REWIND_DETAIL_MAX) lines.push(`  … 另 ${list.length - REWIND_DETAIL_MAX} 个`);
  return lines;
}

/** 代码恢复结果一行（不含明细）。overwrite 时冲突文件已被覆盖，算作已恢复。 */
export function codeResultText(code: CodeRestoreResult, overwrite = false): string {
  const done = overwrite
    ? new Set([...code.restored, ...code.deleted, ...code.conflicts]).size
    : codeFileCount(code);
  const skipped = skips(code, overwrite);
  const why = skipped.length > 0 ? `（${reasonCounts(skipped)}）` : "";
  if (done > 0) {
    return skipped.length > 0
      ? `已恢复 ${done} 个文件，跳过 ${skipped.length} 个${why}`
      : `已恢复 ${done} 个文件`;
  }
  if (skipped.length > 0) return `没有文件被恢复，跳过 ${skipped.length} 个${why}`;
  return "代码没有变化";
}

/** 结果通知（多行）：代码结果 + 明细 + 对话说明 + git 提示。 */
export function rewindResultLines(
  result: RewindResult,
  options: { overwrite?: boolean; conversation?: string } = {},
): string[] {
  const lines: string[] = [];
  const overwrite = options.overwrite === true;
  if (result.code !== undefined) {
    lines.push(codeResultText(result.code, overwrite), ...skipDetailLines(result.code, overwrite));
  }
  if (result.conversation !== undefined && options.conversation !== undefined) {
    lines.push(options.conversation);
  }
  if (result.gitHint !== undefined) lines.push(...gitHintLines(result.gitHint));
  return lines;
}

function short(hash: string, n: number): string {
  return hash.slice(0, n);
}

/** HEAD 变化提示：一行说明 + 两条命令（不执行）；`brief` 去掉括号说明。 */
export function gitHintLines(
  hint: { recordedHead: string; currentHead: string },
  ascii = false,
  brief = false,
): string[] {
  const recorded = short(hint.recordedHead, 12);
  const change = `${short(hint.recordedHead, 7)} ${ascii ? "->" : "→"} ${short(hint.currentHead, 7)}`;
  return [
    `git HEAD 已变化：${change}${brief ? "" : "（ama 不动 git）"}`,
    `  git log --oneline ${recorded}..HEAD`,
    `  git reset --soft ${recorded}`,
  ];
}

/** 回滚接口的错误 → 中文说明。 */
export function rewindErrorText(error: unknown): string {
  if (isAmaError(error)) {
    switch (error.code) {
      case "busy":
        return "正在运行，不能回滚（先按 Esc 中断）";
      case "no_checkpoint":
        return "这条消息没有代码检查点，只能恢复对话";
      case "rewind_failed": {
        const detail = error.detail as Partial<CodeRestoreResult> | undefined;
        const failed = (detail?.failed ?? []).map((f) => `${f.path}：${f.message}`);
        return failed.length > 0
          ? `没有文件被恢复：${failed.slice(0, REWIND_DETAIL_MAX).join("；")}`
          : "没有文件被恢复";
      }
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
