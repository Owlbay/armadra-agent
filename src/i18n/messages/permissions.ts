/**
 * 消息目录：permissions（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I2]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 *
 * 模式显示名（`Manual`、`Accept edits`…）两种语言都是英文，不在这里；这里是说明、执行前预览与 Bypass 确认。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

/** 预览里一个路径参数的动作（`permissions/preview.ts`）。 */
export type PreviewVerb =
  "append" | "overwrite" | "delete" | "move" | "moveTo" | "gitClean" | "discard";

/** 预览路径行尾的补充说明。 */
export type PreviewNote = "intoDir" | "overwritten" | "gitCleanTracked";

const EN_VERB: Record<PreviewVerb, string> = {
  append: "Append to",
  overwrite: "Overwrite",
  delete: "Delete",
  move: "Move",
  moveTo: "Move to",
  gitClean: "git clean scope",
  discard: "Discard changes",
};

const ZH_VERB: Record<PreviewVerb, string> = {
  append: "追加写入",
  overwrite: "覆盖写入",
  delete: "删除",
  move: "移动",
  moveTo: "移到",
  gitClean: "git clean 范围",
  discard: "丢弃改动",
};

const EN_NOTE: Record<PreviewNote, string> = {
  intoDir: " (existing directory; moves into it)",
  overwritten: " (exists; will be overwritten)",
  gitCleanTracked: " (count includes tracked files; only untracked ones are deleted)",
};

const ZH_NOTE: Record<PreviewNote, string> = {
  intoDir: "（已存在的目录，移入其中）",
  overwritten: "（已存在，将被覆盖）",
  gitCleanTracked: "（计数含已跟踪文件，实际只删未跟踪的）",
};

export const en = {
  /** 六种权限模式的一行说明（`permissions/modes.ts`）。 */
  modeDescription: {
    default: "Ask before writing files or running commands",
    autoEdit: "Accept file edits automatically; still ask before commands",
    plan: "Read-only research and commands; approve the plan to run",
    auto: "ama judges each step: safe ones run, risky ones ask",
    fullAuto: "Allow everything (dangerous commands still ask)",
    allowlist: "Allow only what allow rules match; deny the rest, never ask",
  },
  /** auto 判定层的名字（审批框、`/permissions`）。 */
  autoLayer: {
    rule: "rule layer",
    static: "static check",
    classifier: "classifier",
  },
  bypass: {
    title: "Enter Bypass permissions?",
    riskAllowAll: "No tool call will ask anymore: file writes, commands and network run directly",
    riskDangerous:
      "Only dangerous commands still ask and deny rules still apply; use it only in a throwaway sandbox or container",
    choiceEnter: "Enter Bypass",
    choiceCancel: "Cancel",
    lineQuestion: "Enter Bypass? [y/N] ",
  },
  preview: {
    moreHidden: (n: number) => `… ${n} more not listed`,
    timedOut: (ms: number) => `Count timed out (> ${ms} ms); actual scope may be larger`,
    missing: "does not exist",
    symlink: "symlink",
    file: (size: string) => `file, ${size}`,
    dirCapped: (max: number) => `directory, > ${max} entries`,
    dir: (files: number, size: string, partial: boolean) =>
      `directory, ${plural(files, "file")}, ${size}${partial ? " (count incomplete)" : ""}`,
    pathUnexpanded: (verb: PreviewVerb, word: string) =>
      `${EN_VERB[verb]} ${word}: contains wildcards or variables, not expanded; actual scope may be larger`,
    pathTarget: (verb: PreviewVerb, path: string, detail: string, note: PreviewNote | undefined) =>
      `${EN_VERB[verb]} ${path}: ${detail}${note === undefined ? "" : EN_NOTE[note]}`,
    rmUnknown: (name: string) => `${name}: paths come from a pipe or expansion; scope unknown`,
    gitResetHard:
      "git reset --hard: discards all uncommitted changes in the working tree and the index",
    dangerous: (description: string) => `Dangerous: ${description}`,
    tooDeep: "Nested too deep; inner commands not expanded",
    unread: (tool: string) =>
      `This file has not been read in this session; ${tool} will be rejected (read it first)`,
    size: (lines: number, size: string) => `${plural(lines, "line")}, ${size}`,
    writeNew: (path: string, next: string) => `Create ${path}: ${next}`,
    writeIsDir: (path: string) => `${path} is a directory; write will fail`,
    writeOverwrite: (path: string, before: string, next: string) =>
      `Overwrite ${path}: ${before} → ${next}`,
    editNotUnique: (what: string, count: string) => `${what} is not unique (${count} matches)`,
    editNotFound: (what: string) => `${what} not found`,
    editOverlap: "edit ranges overlap",
    editNoChange: "content is the same before and after",
    editMissing: (path: string) => `${path} does not exist or is not a file; edit will fail`,
    editTooLarge: (path: string, size: string) =>
      `Edit ${path}: ${size}, file too large; dry run skipped`,
    editPlan: (path: string, replacements: number, fuzzy: boolean) =>
      `Edit ${path}: ${plural(replacements, "replacement")}${fuzzy ? " (matched after normalizing whitespace / quotes)" : ""}`,
    editOp: (index: number, removed: number, added: number) =>
      `  #${index} −${removed}/+${added} lines`,
    editMore: (n: number) => `  … ${n} more`,
    editTotal: (before: number, after: number) => `  Total ${before} → ${after} lines`,
    editDryRunFailed: (path: string, reason: string) => `Edit ${path}: dry run failed — ${reason}`,
    failed: (reason: string) => `Preview failed: ${reason}`,
    moreLines: (n: number) => `… ${plural(n, "more line")}`,
  },
};

export const zh = {
  modeDescription: {
    default: "写文件、执行命令前询问",
    autoEdit: "自动接受文件编辑，执行命令仍询问",
    plan: "只读调研，只跑只读命令，出计划后审批执行",
    auto: "由 ama 判断每一步：安全的自动放行，有风险的才问",
    fullAuto: "全部放行（危险命令仍询问）",
    allowlist: "只放行 allow 规则命中的，其余拒绝，从不询问",
  },
  autoLayer: {
    rule: "规则层",
    static: "静态判定",
    classifier: "分类器",
  },
  bypass: {
    title: "进入 Bypass permissions？",
    riskAllowAll: "所有工具调用都不再询问：写文件、执行命令、联网直接放行",
    riskDangerous: "只有危险命令仍会询问，deny 规则照常生效；只建议在一次性沙箱、容器里用",
    choiceEnter: "进入 Bypass",
    choiceCancel: "取消",
    lineQuestion: "确认进入 Bypass？[y/N] ",
  },
  preview: {
    moreHidden: (n) => `… 另 ${n} 处未列出`,
    timedOut: (ms) => `统计超时（> ${ms} ms），实际范围可能更大`,
    missing: "不存在",
    symlink: "符号链接",
    file: (size) => `文件，${size}`,
    dirCapped: (max) => `目录，> ${max} 项`,
    dir: (files, size, partial) =>
      `目录，${files} 个文件，${size}${partial ? "（统计未完成）" : ""}`,
    pathUnexpanded: (verb, word) =>
      `${ZH_VERB[verb]} ${word}：含通配符或变量，未展开，实际范围可能更大`,
    pathTarget: (verb, path, detail, note) =>
      `${ZH_VERB[verb]} ${path}：${detail}${note === undefined ? "" : ZH_NOTE[note]}`,
    rmUnknown: (name) => `${name}：路径来自管道或展开，范围未知`,
    gitResetHard: "git reset --hard：丢弃工作区与暂存区的全部未提交改动",
    dangerous: (description) => `危险：${description}`,
    tooDeep: "嵌套过深，内层命令未展开",
    unread: (tool) => `本会话未 read 过此文件，${tool} 会被拒绝（先 read）`,
    size: (lines, size) => `${lines} 行，${size}`,
    writeNew: (path, next) => `新建 ${path}：${next}`,
    writeIsDir: (path) => `${path} 是目录，write 会失败`,
    writeOverwrite: (path, before, next) => `覆盖 ${path}：${before} → ${next}`,
    editNotUnique: (what, count) => `${what} 匹配不唯一（${count} 处）`,
    editNotFound: (what) => `未找到 ${what}`,
    editOverlap: "多处修改的区间重叠",
    editNoChange: "修改前后内容相同",
    editMissing: (path) => `${path} 不存在或不是文件，edit 会失败`,
    editTooLarge: (path, size) => `修改 ${path}：${size}，文件过大，未干跑`,
    editPlan: (path, replacements, fuzzy) =>
      `修改 ${path}：${replacements} 处替换${fuzzy ? "（空白 / 引号归一后匹配）" : ""}`,
    editOp: (index, removed, added) => `  #${index} −${removed}/+${added} 行`,
    editMore: (n) => `  … 另 ${n} 处`,
    editTotal: (before, after) => `  共 ${before} → ${after} 行`,
    editDryRunFailed: (path, reason) => `修改 ${path}：干跑失败——${reason}`,
    failed: (reason) => `预览失败：${reason}`,
    moreLines: (n) => `… 另 ${n} 行`,
  },
} satisfies Messages<typeof en>;
