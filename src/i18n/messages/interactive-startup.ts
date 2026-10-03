/**
 * 消息目录：interactive 的启动部分（键名规范见 docs/i18n.md）。[W6-I2]
 *
 * 单文件 600 行上限，`interactive.ts` 拆出：启动头（`startup-header.ts`）与启动期交互（`startup-ui.ts`：
 * 信任、恢复会话、选模型、工作目录）。经 `msg().interactive.startup` 取用。
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  header: {
    trusted: "trusted",
    untrusted: "untrusted",
    trustSource: (source: string) => ` (${source})`,
    templates: (n: number) => plural(n, "template"),
    host: (host: string) => `host ${host}`,
    warnings: (n: number) => `${plural(n, "warning")} (ama doctor)`,
    hintCompact: "/help · Shift+Tab mode",
    keyModel: "Model",
    keyDir: "Folder",
    keyMode: "Mode",
    keyLoaded: "Loaded",
    keyHost: "Host",
    keyWarnings: "Warnings",
    thinking: (level: string) => `thinking ${level}`,
    preset: (preset: string) => `preset ${preset}`,
    warningsValue: (n: number) => `${n} (see ama doctor)`,
    hint: "/help commands · Shift+Tab mode · Ctrl+O expand tool output",
  },
  ui: {
    cancelled: "(cancelled)",
    hintFilter: (arrows: string) =>
      `type to filter · ${arrows} select · Enter confirm · Esc cancel`,
    hintNumbers: (arrows: string, n: number) =>
      `${arrows} select · Enter confirm · 1-${n} pick · Esc cancel`,
    hint: (arrows: string) => `${arrows} select · Enter confirm · Esc cancel`,
    justNow: "just now",
    minutesAgo: (n: number) => `${n}m ago`,
    hoursAgo: (n: number) => `${n}h ago`,
    daysAgo: (n: number) => `${n}d ago`,
    messages: (n: number) => plural(n, "message"),
    trustRemember: "Trust and remember",
    trustOnce: "Trust this time only",
    trustSkip: "Don't trust this time",
    trustNever: "Don't trust and remember",
    moreResources: (n: number) => `  …${n} more`,
    trustTitle: "Trust this folder's project resources?",
    resumeTitle: "Resume which session?",
    modelTitle: "Choose a model",
    cwdTitle: "The session's working directory does not exist",
    cwdPrompt: "Enter a replacement directory (Enter confirm · Esc cancel)",
    cwdPlaceholder: "directory path",
    cwdEmpty: "Enter a directory",
    cwdMissing: (path: string) => `Does not exist: ${path}`,
    cwdNotDir: (path: string) => `Not a directory: ${path}`,
  },
};

export const zh = {
  header: {
    trusted: "已信任",
    untrusted: "未信任",
    trustSource: (source) => `（${source}）`,
    templates: (n) => `${n} 模板`,
    host: (host) => `宿主 ${host}`,
    warnings: (n) => `警告 ${n} 条（ama doctor）`,
    hintCompact: "/help · Shift+Tab 切模式",
    keyModel: "模型",
    keyDir: "目录",
    keyMode: "模式",
    keyLoaded: "已加载",
    keyHost: "宿主",
    keyWarnings: "警告",
    thinking: (level) => `思考 ${level}`,
    preset: (preset) => `预设 ${preset}`,
    warningsValue: (n) => `${n} 条（ama doctor 查看）`,
    hint: "/help 命令 · Shift+Tab 切模式 · Ctrl+O 展开工具输出",
  },
  ui: {
    cancelled: "（已取消）",
    hintFilter: (arrows) => `输入过滤 · ${arrows} 选择 · Enter 确认 · Esc 取消`,
    hintNumbers: (arrows, n) => `${arrows} 选择 · Enter 确认 · 1-${n} 直接选 · Esc 取消`,
    hint: (arrows) => `${arrows} 选择 · Enter 确认 · Esc 取消`,
    justNow: "刚刚",
    minutesAgo: (n) => `${n} 分钟前`,
    hoursAgo: (n) => `${n} 小时前`,
    daysAgo: (n) => `${n} 天前`,
    messages: (n) => `${n} 条`,
    trustRemember: "信任并记住",
    trustOnce: "仅本次信任",
    trustSkip: "本次不信任",
    trustNever: "不信任并记住",
    moreResources: (n) => `  …另有 ${n} 项`,
    trustTitle: "信任这个目录的项目资源？",
    resumeTitle: "恢复哪个会话？",
    modelTitle: "选择模型",
    cwdTitle: "会话的工作目录不存在",
    cwdPrompt: "输入替代目录（Enter 确认 · Esc 取消）",
    cwdPlaceholder: "目录路径",
    cwdEmpty: "请输入目录",
    cwdMissing: (path) => `不存在：${path}`,
    cwdNotDir: (path) => `不是目录：${path}`,
  },
} satisfies Messages<typeof en>;
