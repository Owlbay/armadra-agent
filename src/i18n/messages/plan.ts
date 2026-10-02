/**
 * 消息目录：plan（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I2]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 *
 * `/plan` 命令（`plan-command.ts`）、Plan 审批框（`plan-dialog.ts`）与审批后的提示（`plan-flow.ts`）。
 * 用户**输入**的别名（`批准`、步骤标题）不在这里，两种语言同时识别（`plan/controller.ts`、`plan/extract.ts`）。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  usage: "Usage: /plan [goal] | /plan approve [mode|fresh] | /plan reject",
  status: {
    proposed: "awaiting approval",
    approved: "approved",
    rejected: "rejected",
    superseded: "superseded by a newer version",
  },
  untitled: "(untitled)",
  command: {
    modePlan: (back: string) => `Mode: Plan (returns to ${back} after approval)`,
    mode: (mode: string) => `Mode: ${mode}`,
    noPlanYet: "No plan yet: approve here once the model gives a <proposed_plan>",
    noPlan: "No plan. /plan <goal> enters Plan mode",
    head: (version: number, status: string, title: string) =>
      `Plan v${version} · ${status} · ${title}`,
    file: (path: string) => `File: ${path}`,
    steps: (n: number) => `Steps (${n}):`,
    todos: (done: number, total: number, current: string | undefined) =>
      `Todos: ${done}/${total} done${current !== undefined ? ` · in progress ${current}` : ""}`,
    actions:
      "/plan approve [mode|fresh] to approve · /plan reject to reject · type to give feedback",
    notFound: "No plan awaiting approval",
    unavailable: "This session has no Plan capability",
    invalidMode: (arg: string, usage: string) => `Invalid execution mode: ${arg} (${usage})`,
    approved: (version: number, mode: string) => `Approved plan v${version}; running in ${mode}`,
    rejected: (version: number) => `Rejected plan v${version} (still in Plan mode)`,
  },
  dialog: {
    title: "Plan awaiting approval",
    optionApprove: "Approve and run",
    optionApproveFresh: "Approve, run in fresh context",
    optionRevise: (ellipsis: string) => `Keep revising${ellipsis}`,
    optionReject: "Reject and leave Plan mode",
    modeBack: (mode: string) => `Back to the previous mode (${mode})`,
    modeHeadingFresh: "Run in a fresh context; execution mode",
    modeHeading: "Execution mode",
    editing: (ellipsis: string) => `Editing in the external editor${ellipsis}`,
    version: (version: number) => `Plan v${version}`,
    stepCount: (n: number) => plural(n, "step"),
    edited: "Edited in the editor: approval runs the edited plan",
    moreSteps: (ellipsis: string, n: number) =>
      `  ${ellipsis} ${plural(n, "more step")} (/plan shows all)`,
    feedbackCompact: "Feedback",
    feedback: "Feedback (stays in Plan mode; the model rewrites the plan)",
    hintMainCompact: (arrows: string, edit: boolean) =>
      `${arrows} Enter${edit ? " · e edit" : ""} · Esc stay in Plan`,
    hintMain: (arrows: string, edit: boolean) =>
      `${arrows} select · Enter confirm${edit ? " · e edit plan" : ""} · Esc stay in Plan`,
    hintModeCompact: (arrows: string) => `${arrows} Enter · Esc back`,
    hintMode: (arrows: string) => `${arrows} select · Enter confirm · Esc back`,
    hintReviseCompact: (edit: boolean) => `Enter send${edit ? " · Ctrl+E editor" : ""} · Esc back`,
    hintRevise: (edit: boolean) =>
      `Enter send${edit ? " · Ctrl+E external editor" : ""} · Esc back`,
    hintEditing: "Save and close the editor to come back here",
  },
  flow: {
    pending: (version: number) => `Plan v${version} awaits approval: /plan opens the dialog`,
    approved: (version: number, mode: string) => `Approved plan v${version}; running in ${mode}`,
    approvedFresh: (version: number, sessionId: string, mode: string) =>
      `Approved plan v${version}; running in ${mode} in new session ${sessionId}`,
    rejectedExit: (version: number, mode: string) => `Rejected plan v${version}; back to ${mode}`,
    rejectedStay: (version: number) =>
      `Rejected plan v${version} (still in Plan mode; /plan to view)`,
  },
};

export const zh = {
  usage: "用法：/plan [目标] | /plan approve [模式|fresh] | /plan reject",
  status: {
    proposed: "待审批",
    approved: "已批准",
    rejected: "已放弃",
    superseded: "已被新版本取代",
  },
  untitled: "（无标题）",
  command: {
    modePlan: (back) => `模式：Plan（批准后回到 ${back}）`,
    mode: (mode) => `模式：${mode}`,
    noPlanYet: "还没有计划：模型给出 <proposed_plan> 后在这里审批",
    noPlan: "没有计划。/plan <目标> 进入 Plan 模式",
    head: (version, status, title) => `计划 v${version} · ${status} · ${title}`,
    file: (path) => `文件：${path}`,
    steps: (n) => `步骤（${n}）：`,
    todos: (done, total, current) =>
      `待办：${done}/${total} 完成${current !== undefined ? ` · 进行中 ${current}` : ""}`,
    actions: "/plan approve [模式|fresh] 批准 · /plan reject 放弃 · 直接输入修改意见",
    notFound: "没有待审批的计划",
    unavailable: "当前会话没有 Plan 能力",
    invalidMode: (arg, usage) => `执行模式无效：${arg}（${usage}）`,
    approved: (version, mode) => `已批准计划 v${version}，以 ${mode} 执行`,
    rejected: (version) => `已放弃计划 v${version}（仍在 Plan 模式）`,
  },
  dialog: {
    title: "计划待审批",
    optionApprove: "批准并执行",
    optionApproveFresh: "批准，在新上下文执行",
    optionRevise: (ellipsis) => `继续修改${ellipsis}`,
    optionReject: "放弃，退出 Plan 模式",
    modeBack: (mode) => `回到进入前的模式（${mode}）`,
    modeHeadingFresh: "在新上下文执行，执行模式",
    modeHeading: "执行模式",
    editing: (ellipsis) => `正在外部编辑器里编辑${ellipsis}`,
    version: (version) => `计划 v${version}`,
    stepCount: (n) => `${n} 步`,
    edited: "已在编辑器里修改：批准时以修改后的计划执行",
    moreSteps: (ellipsis, n) => `  ${ellipsis} 另 ${n} 步（/plan 查看全部）`,
    feedbackCompact: "修改意见",
    feedback: "修改意见（留在 Plan 模式，模型据此重写计划）",
    hintMainCompact: (arrows, edit) => `${arrows} Enter${edit ? " · e 编辑" : ""} · Esc 留在 Plan`,
    hintMain: (arrows, edit) =>
      `${arrows} 选择 · Enter 确认${edit ? " · e 编辑计划" : ""} · Esc 留在 Plan`,
    hintModeCompact: (arrows) => `${arrows} Enter · Esc 返回`,
    hintMode: (arrows) => `${arrows} 选择 · Enter 确认 · Esc 返回`,
    hintReviseCompact: (edit) => `Enter 发送${edit ? " · Ctrl+E 编辑器" : ""} · Esc 返回`,
    hintRevise: (edit) => `Enter 发送${edit ? " · Ctrl+E 外部编辑器" : ""} · Esc 返回`,
    hintEditing: "保存并关闭编辑器后回到这里",
  },
  flow: {
    pending: (version) => `计划 v${version} 待审批：/plan 打开审批框`,
    approved: (version, mode) => `已批准计划 v${version}，以 ${mode} 执行`,
    approvedFresh: (version, sessionId, mode) =>
      `已批准计划 v${version}，在新会话 ${sessionId} 以 ${mode} 执行`,
    rejectedExit: (version, mode) => `已放弃计划 v${version}，回到 ${mode}`,
    rejectedStay: (version) => `已放弃计划 v${version}（仍在 Plan 模式，/plan 查看）`,
  },
} satisfies Messages<typeof en>;
