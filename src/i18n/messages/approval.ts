/**
 * 消息目录：approval（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I2]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 *
 * 审批对话框（`modes/interactive/approval-dialog.ts`）、通用确认框（`confirm-dialog.ts`）与行式审批。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  /** 外部 Agent 来源标注：`[claude · session abc12345]`。 */
  originLabel: (agent: string, sessionId: string) => `[${agent} · session ${sessionId}]`,
  /** 标题里的原因。 */
  title: {
    firstRun: "First run of an external agent",
    dangerous: "Dangerous command",
    hook: "Hook asks for confirmation",
    confirm: "Needs confirmation",
  },
  /** 首行工具名右侧的标签。 */
  tag: {
    dangerous: "Dangerous command",
    hook: "Hook asks for confirmation",
    firstRun: "First run",
    confirm: "Needs confirmation",
  },
  morePaths: (n: number) => `… ${plural(n, "more path")}`,
  moreLines: (n: number) => `… ${plural(n, "more line")}`,
  moreLinesView: (n: number) => `… ${plural(n, "more line")} (v to view)`,
  moreEdits: (n: number) => `… ${plural(n, "more edit")}`,
  firstRunMode: (mode: string) => `Mode ${mode}`,
  writeLines: (n: number) => `writes ${plural(n, "line")}`,
  editCount: (n: number) => plural(n, "edit"),
  externalRunner: (agent: string, runner: string) =>
    `External agent ${agent}: runs with your ${runner} CLI login (includes this session's first-run confirmation)`,
  originAsks: (agent: string) => `${agent} asks for confirmation`,
  firstRunLogin: "First run of this CLI with your login in this session",
  hookReason: (reason: string | undefined) => `Hook: ${reason ?? "(no reason given)"}`,
  dangerousWarn: "This command may be destructive; please confirm",
  autoReason: (layer: string, reason: string) => `Auto ${layer}: ${reason}`,
  modeNeedsConfirm: (mode: string) => `Confirmation required in permission mode ${mode}`,
  option: {
    allow: "Allow",
    allowSession: "Allow for this session",
    deny: "Deny",
  },
  hint: (arrows: string) => `${arrows} select · Enter confirm · v full input`,
  hintCompact: (arrows: string) => `${arrows} Enter · v full input`,
  /** 消息区里的结果说明。 */
  outcome: {
    allow: (what: string) => `Allowed ${what}`,
    allowSession: (what: string) => `Allowed ${what} (similar calls won't ask again this session)`,
    deny: (what: string) => `Denied ${what}`,
    cancelled: (what: string) => `Approval cancelled (timeout or interrupt): ${what}`,
  },
  /** 通用确认框的按键行。 */
  choiceHint: (arrows: string, n: number) =>
    `${arrows} select · Enter confirm · 1-${n} pick · Esc cancel`,
};

export const zh = {
  originLabel: (agent, sessionId) => `[${agent} · 会话 ${sessionId}]`,
  title: {
    firstRun: "首次运行外部 Agent",
    dangerous: "危险命令",
    hook: "Hook 要求确认",
    confirm: "需要确认",
  },
  tag: {
    dangerous: "危险命令",
    hook: "Hook 要求确认",
    firstRun: "首次运行",
    confirm: "需要确认",
  },
  morePaths: (n) => `… 另 ${n} 个路径`,
  moreLines: (n) => `… 另 ${n} 行`,
  moreLinesView: (n) => `… 另 ${n} 行（v 查看）`,
  moreEdits: (n) => `… 另 ${n} 处`,
  firstRunMode: (mode) => `模式 ${mode}`,
  writeLines: (n) => `写入 ${n} 行`,
  editCount: (n) => `${n} 处修改`,
  externalRunner: (agent, runner) =>
    `外部 Agent ${agent}：以你在 ${runner} CLI 的登录运行（含本会话首次运行确认）`,
  originAsks: (agent) => `${agent} 请求确认`,
  firstRunLogin: "本会话首次以你的登录运行该 CLI",
  hookReason: (reason) => `Hook：${reason ?? "（无说明）"}`,
  dangerousWarn: "这条命令可能有破坏性，请确认",
  autoReason: (layer, reason) => `Auto ${layer}：${reason}`,
  modeNeedsConfirm: (mode) => `权限模式 ${mode} 下需要确认`,
  option: {
    allow: "允许",
    allowSession: "本会话允许同类",
    deny: "拒绝",
  },
  hint: (arrows) => `${arrows} 选择 · Enter 确认 · v 完整输入`,
  hintCompact: (arrows) => `${arrows} Enter · v 完整输入`,
  outcome: {
    allow: (what) => `已允许 ${what}`,
    allowSession: (what) => `已允许 ${what}（本会话同类不再询问）`,
    deny: (what) => `已拒绝 ${what}`,
    cancelled: (what) => `审批已取消（超时或中断）：${what}`,
  },
  choiceHint: (arrows, n) => `${arrows} 选择 · Enter 确认 · 1-${n} 直接选 · Esc 取消`,
} satisfies Messages<typeof en>;
