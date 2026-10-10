/**
 * 消息目录：interactive 的行式界面部分（键名规范见 docs/guides/i18n.md）。[W6-I2]
 *
 * 单文件 600 行上限，`interactive.ts` 拆出：`modes/interactive/line/**`（行式审批问句、事件行、选择列表、
 * 启动行与中断提示）。经 `msg().interactive.line` 取用。en 是形状源；zh 用 `satisfies Messages<typeof en>`。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

/** 行式审批问句里括号说明的来由。 */
export type LineApprovalWhy =
  | { kind: "dangerous" }
  | { kind: "hook"; reason: string }
  | { kind: "auto"; layer: string; reason: string };

function enWhy(why: LineApprovalWhy | undefined): string {
  if (why === undefined) return "";
  if (why.kind === "dangerous") return " (dangerous command)";
  if (why.kind === "hook") return ` (${why.reason})`;
  return ` (Auto ${why.layer}: ${why.reason})`;
}

function zhWhy(why: LineApprovalWhy | undefined): string {
  if (why === undefined) return "";
  if (why.kind === "dangerous") return "（危险命令）";
  if (why.kind === "hook") return `（${why.reason}）`;
  return `（Auto ${why.layer}：${why.reason}）`;
}

export const en = {
  approvalOrigin: (task: string, title: string, where: string | undefined) =>
    `${task}Allow ${title}${where !== undefined ? ` ${where}` : ""}? [y allow / a allow all this session / N deny] `,
  approvalFirstRun: (task: string, note: string) => `${task}${note} Allow? [y allow / N deny] `,
  approvalTool: (task: string, tool: string, summary: string, why: LineApprovalWhy | undefined) =>
    `${task}Allow ${tool}${summary !== "" ? ` ${summary}` : ""}${enWhy(why)}? [y allow / a allow all this session / N deny] `,
  retry: (attempt: number, max: number, seconds: number, error: string) =>
    `↻ Retry ${attempt}/${max} (${seconds}s): ${error}`,
  compacting: "… Compacting context",
  error: (error: string) => `ama: error: ${error}`,
  planProposed: (version: number, file: string | undefined) =>
    `◇ Plan v${version} awaits approval${file !== undefined ? ` (${file})` : ""}: /plan approve [mode|fresh] to approve · /plan reject to reject · type to give feedback`,
  subagentStart: (taskId: string, agent: string, background: boolean) =>
    `  ↳ ${taskId} ${agent}${background ? " (background)" : ""} started`,
  modelsHeading: "Available models (/model <provider/id>):",
  noSessions: "No sessions in this directory",
  sessionsHeading: "Recent sessions (/resume <id>):",
  noForkable: "No messages to fork from yet",
  forkHeading: "Fork points (/fork <entry id>):",
  modeHeading: "Mode (/permission <mode>):",
  thinking: (levels: string, current: string) =>
    `Thinking level (/thinking <level>): ${levels}; current ${current}`,
  banner: (version: string, model: string) =>
    `ama ${version} · ${model} · /help for commands, Ctrl+D to quit`,
  interrupted: "^C interrupted",
  ctrlCAgain: "(press Ctrl+C again to quit)",
  steer: (text: string) => `↳ steer: ${text}`,
  pasteMarker: (id: number, lines: number) => `[paste #${id} +${plural(lines, "line")}]`,
};

export const zh = {
  approvalOrigin: (task, title, where) =>
    `${task}允许 ${title}${where !== undefined ? ` ${where}` : ""}？[y 允许 / a 本会话都允许 / N 拒绝] `,
  approvalFirstRun: (task, note) => `${task}${note} 允许？[y 允许 / N 拒绝] `,
  approvalTool: (task, tool, summary, why) =>
    `${task}允许 ${tool}${summary !== "" ? ` ${summary}` : ""}${zhWhy(why)}？[y 允许 / a 本会话都允许 / N 拒绝] `,
  retry: (attempt, max, seconds, error) => `↻ 重试 ${attempt}/${max}（${seconds}s）：${error}`,
  compacting: "… 压缩上下文",
  error: (error) => `ama: 错误：${error}`,
  planProposed: (version, file) =>
    `◇ 计划 v${version} 待审批${file !== undefined ? `（${file}）` : ""}：/plan approve [模式|fresh] 批准 · /plan reject 放弃 · 直接输入修改意见`,
  subagentStart: (taskId, agent, background) =>
    `  ↳ ${taskId} ${agent}${background ? "（后台）" : ""} 开始`,
  modelsHeading: "可用模型（/model <provider/id>）：",
  noSessions: "本目录没有会话",
  sessionsHeading: "最近的会话（/resume <id>）：",
  noForkable: "还没有可分叉的消息",
  forkHeading: "可分叉的位置（/fork <条目 id>）：",
  modeHeading: "Mode（/permission <模式>）：",
  thinking: (levels, current) => `思考级别（/thinking <级别>）：${levels}；当前 ${current}`,
  banner: (version, model) => `ama ${version} · ${model} · /help 查看命令，Ctrl+D 退出`,
  interrupted: "^C 已中断",
  ctrlCAgain: "（再按一次 Ctrl+C 退出）",
  steer: (text) => `↳ steer：${text}`,
  pasteMarker: (id, lines) => `[粘贴 #${id} +${lines} 行]`,
} satisfies Messages<typeof en>;
