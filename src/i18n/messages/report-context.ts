/**
 * 消息目录：report 的 `/context` 部分（键名规范见 docs/i18n.md）。
 *
 * 单文件 600 行上限，从 `report.ts` 拆出；经 `msg().report.contextReport` 取用（modes/context-report.ts）。
 * 只有数字与名字的格式，不含任何正文。en 是形状源；zh 用 `satisfies Messages<typeof en>`。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  title: "Context",
  keyUsed: "Used",
  used: (tokens: string, window: string, percent: string | undefined) =>
    `${tokens} / ${window}${percent !== undefined ? ` (${percent})` : ""}`,
  keyLeft: "Left",
  left: (tokens: string) => `${tokens} tokens`,
  keySource: "Source",
  sourceUsage: (usage: string, estimate: string) =>
    `reported usage ${usage} + estimated ${estimate}`,
  sourceEstimate: "estimated in full (no usable usage yet)",
  keyAutoCompact: "Auto-compact",
  autoCompact: (at: string, distance: string) => `at ${at}, ≈ ${distance} to go`,
  autoCompactReached: (at: string) => `at ${at}, reached`,
  autoCompactOff: "off",
  windowUnknown: "window unknown",
  keyPrune: "Pruning",
  prune: (at: string) => `old tool results trimmed from ${at}`,
  breakdown: (total: string) => `By category (estimated, ${total})`,
  prefixCounted:
    "System prompt and tool declarations are counted from the stored system messages; the full estimate can differ from reported usage.",
  prefixPending: "System prompt and tool declarations are not counted until the first request.",
  categories: {
    system: "System prompt",
    tools: "Tool declarations",
    user: "User messages",
    assistant: "Assistant text",
    reasoning: "Reasoning",
    toolCalls: "Tool-call arguments",
    toolResults: "Tool results",
    images: "Images",
    summaries: "Summaries",
    custom: "Custom messages",
  },
  partNames: {
    compaction: "compaction",
    branch: "branch",
    user: "user",
    toolResult: "tool result",
    custom: "custom",
  },
  images: (count: number) => plural(count, "image"),
  more: (count: number) => `+${count} more`,
  largest: (count: number) => `Largest tool results (top ${count})`,
  noToolResults: "no tool results",
  empty: "No messages in the context yet.",
};

export const zh = {
  title: "上下文",
  keyUsed: "已用",
  used: (tokens, window, percent) =>
    `${tokens} / ${window}${percent !== undefined ? `（${percent}）` : ""}`,
  keyLeft: "剩余",
  left: (tokens) => `${tokens} token`,
  keySource: "来源",
  sourceUsage: (usage, estimate) => `usage 实测 ${usage} + 估算 ${estimate}`,
  sourceEstimate: "全量估算（还没有可用的 usage）",
  keyAutoCompact: "自动压缩",
  autoCompact: (at, distance) => `${at} 触发，还差 ≈ ${distance}`,
  autoCompactReached: (at) => `${at} 触发，已达到`,
  autoCompactOff: "关闭",
  windowUnknown: "窗口未知",
  keyPrune: "裁剪",
  prune: (at) => `超过 ${at} 时清理旧工具结果`,
  breakdown: (total) => `按类别（估算，${total}）`,
  prefixCounted: "系统提示与工具声明按会话里存的 system 消息计入；全量估算可能与 usage 实测不同。",
  prefixPending: "系统提示与工具声明在首次请求后才计入。",
  categories: {
    system: "系统提示",
    tools: "工具声明",
    user: "用户消息",
    assistant: "助手文本",
    reasoning: "推理",
    toolCalls: "工具调用参数",
    toolResults: "工具结果",
    images: "附件图片",
    summaries: "摘要",
    custom: "自定义消息",
  },
  partNames: {
    compaction: "压缩",
    branch: "分支",
    user: "用户",
    toolResult: "工具结果",
    custom: "自定义",
  },
  images: (count) => `${count} 张`,
  more: (count) => `另有 ${count} 项`,
  largest: (count) => `最大的工具结果（前 ${count}）`,
  noToolResults: "没有工具结果",
  empty: "上下文里还没有消息。",
} satisfies Messages<typeof en>;
