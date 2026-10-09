/**
 * normalizeContext（设计 §1.2 ai/context.ts）：把循环交来的转录（含 `system` 补丁消息）变成
 * 协议可直接拼请求体的形状。
 *
 * - system 折叠：首条非 system 消息之前的 system 消息按出现顺序重放（节名级替换，null 删除），
 *   得到 `systemSections`（保持节首次出现的顺序）与拼好的 `systemPrompt`（节间空一行）；
 * - 中途节补丁（设计 §9.1「会话中途变化的上下文只追加」）：对话开始之后的 system 补丁不改写开头，
 *   渲染成 `<system-reminder>` 包裹的 user 消息按位置插回，开头与之前的消息逐字节不变；
 * - 工具表（[ME-B] D5）：对话开始前按顺序重放 `toolsRemoved`（先）与 `toolsAdded`（后），同名后者覆盖；
 *   开始之后声明冻结——移除不删声明、只在尾部提醒（执行层拒绝调用），已有名字不覆盖（加回只提醒
 *   「available again」），新名字追加在末尾。开头与工具表在会话内只写一次；
 * - 模态过滤：模型不收图片时，用户消息与工具结果里的图片块换成文字占位。
 *
 * 支持「中途 system 消息」的协议（compat.supportsMidConvoSystemMessages）用
 * `normalizeContextInline()`：首条非 system 消息之前的 system 折叠进系统提示，之后的补丁
 * 渲染为文本、按位置插回对话。
 */

import type {
  AssistantMessage,
  ContentBlock,
  Model,
  NormalizedContext,
  SystemMessage,
  ToolDecl,
  ToolResultMessage,
  TranscriptContext,
  UserMessage,
} from "./types.js";

export interface NormalizeOptions {
  /** 提供时按 `model.input` 过滤模态。 */
  model?: Pick<Model, "input"> | undefined;
}

export const IMAGE_OMITTED_TEXT = "[image omitted: the model does not accept image input]";

type ConversationMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** 对话开始后移除工具：声明保留，尾部提醒（固定英文；执行层拒绝文案见 agent/tool-availability.ts）。 */
export const toolRemovedReminder = (name: string): string =>
  `Tool "${name}" is no longer available in this session; calls to it are rejected.`;

/** 移除后又加回（声明沿用首次版本）。 */
export const toolRestoredReminder = (name: string): string => `Tool "${name}" is available again.`;

class SystemState {
  readonly sections = new Map<string, string>();
  readonly tools = new Map<string, ToolDecl>();

  /** `started`：对话已开始——工具声明冻结（移除不删、已有名字不覆盖、新名字追加）。 */
  apply(message: SystemMessage, started = false): void {
    for (const [name, value] of Object.entries(message.sections)) {
      if (value === null) this.sections.delete(name);
      else this.sections.set(name, value);
    }
    if (started) {
      for (const tool of message.toolsAdded ?? [])
        if (!this.tools.has(tool.name)) this.tools.set(tool.name, tool);
      return;
    }
    for (const name of message.toolsRemoved ?? []) this.tools.delete(name);
    for (const tool of message.toolsAdded ?? []) this.tools.set(tool.name, tool);
  }

  snapshot(): Pick<NormalizedContext, "systemPrompt" | "systemSections" | "tools"> {
    const systemSections = [...this.sections.entries()]
      .filter(([, text]) => text.length > 0)
      .map(([name, text]) => ({ name, text }));
    return {
      systemPrompt: systemSections.map((section) => section.text).join("\n\n"),
      systemSections,
      tools: [...this.tools.values()],
    };
  }
}

function filterContent(
  content: string | ContentBlock[],
  allowImages: boolean,
): string | ContentBlock[] {
  if (typeof content === "string" || allowImages) return content;
  if (!content.some((block) => block.type === "image")) return content;
  return content.map((block) =>
    block.type === "image" ? { type: "text" as const, text: IMAGE_OMITTED_TEXT } : block,
  );
}

function filterMessage(message: ConversationMessage, allowImages: boolean): ConversationMessage {
  if (message.role === "assistant" || allowImages) return message;
  const content = filterContent(message.content, allowImages);
  return content === message.content ? message : { ...message, content };
}

function allowsImages(options: NormalizeOptions | undefined): boolean {
  return options?.model === undefined || options.model.input.includes("image");
}

export function normalizeContext(
  context: TranscriptContext,
  options?: NormalizeOptions,
): NormalizedContext {
  const head = new SystemState();
  const tools = new SystemState();
  const messages: ConversationMessage[] = [];
  const allowImages = allowsImages(options);
  const removed = new Set<string>();
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    messages.push({ role: "user", content: systemReminderText(pending), timestamp: 0 });
    pending = [];
  };
  for (const message of context.messages) {
    if (message.role !== "system") {
      flush();
      messages.push(filterMessage(message, allowImages));
      continue;
    }
    const started = messages.length > 0;
    tools.apply(message, started);
    if (!started) {
      head.apply(message);
      continue;
    }
    const text = renderSystemUpdate(message, removed);
    if (text.length > 0) pending.push(text);
  }
  flush();
  return { ...head.snapshot(), tools: tools.snapshot().tools, messages };
}

/** 中途节补丁作为尾部上下文消息送达时的文本（固定英文，与界面语言无关）。 */
export function systemReminderText(updates: readonly string[]): string {
  return (
    `<system-reminder>\n${updates.join("\n\n")}\n\n` +
    "These updates replace the earlier versions of those system prompt sections; " +
    "tool availability notes above are current.\n</system-reminder>"
  );
}

/**
 * 渲染一条中途 system 补丁的文本：节变更全文；移除的工具各一句提醒；`removed` 里的名字被加回时
 * 一句「available again」（新工具的声明由请求工具表末尾体现，不另写）。`removed` 随之更新。
 */
export function renderSystemUpdate(message: SystemMessage, removed: Set<string>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(message.sections)) {
    parts.push(
      value === null
        ? `System prompt section "${name}" was removed.`
        : `System prompt section "${name}" was updated:\n\n${value}`,
    );
  }
  for (const tool of message.toolsAdded ?? []) {
    if (!removed.delete(tool.name)) continue;
    parts.push(toolRestoredReminder(tool.name));
  }
  for (const name of message.toolsRemoved ?? []) {
    if (removed.has(name)) continue;
    removed.add(name);
    parts.push(toolRemovedReminder(name));
  }
  return parts.join("\n\n");
}

export interface InlineSystemUpdate {
  /** 插在 `messages[beforeIndex]` 之前；等于 messages.length 表示放在末尾。 */
  beforeIndex: number;
  text: string;
}

export interface InlineNormalizedContext extends NormalizedContext {
  systemUpdates: InlineSystemUpdate[];
}

export function normalizeContextInline(
  context: TranscriptContext,
  options?: NormalizeOptions,
): InlineNormalizedContext {
  const head = new SystemState();
  const tools = new SystemState();
  const messages: ConversationMessage[] = [];
  const systemUpdates: InlineSystemUpdate[] = [];
  const allowImages = allowsImages(options);
  const removed = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "system") {
      messages.push(filterMessage(message, allowImages));
      continue;
    }
    const started = messages.length > 0;
    tools.apply(message, started);
    if (!started) {
      head.apply(message);
      continue;
    }
    const text = renderSystemUpdate(message, removed);
    if (text.length > 0) systemUpdates.push({ beforeIndex: messages.length, text });
  }
  const snapshot = head.snapshot();
  return { ...snapshot, tools: tools.snapshot().tools, messages, systemUpdates };
}

/** 文本内容（用户消息 / 工具结果），图片块忽略。 */
export function contentText(content: string | ContentBlock[], separator = "\n"): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join(separator);
}

/** 去掉孤立代理项（部分供应商对非法 UTF-16 直接 400）。 */
export function sanitizeText(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}
