/**
 * normalizeContext（设计 §1.2 ai/context.ts）：把循环交来的转录（含 `system` 补丁消息）变成
 * 协议可直接拼请求体的形状。
 *
 * - system 折叠：首条非 system 消息之前的 system 消息按出现顺序重放（节名级替换，null 删除），
 *   得到 `systemSections`（保持节首次出现的顺序）与拼好的 `systemPrompt`（节间空一行）；
 * - 中途节补丁（设计 §9.1「会话中途变化的上下文只追加」）：对话开始之后的 system 补丁不改写开头，
 *   渲染成 `<system-reminder>` 包裹的 user 消息按位置插回，开头与之前的消息逐字节不变；
 *   例外是补丁移除了工具——工具表本身已变、前缀必然失效，这时全部补丁照旧折回开头；
 * - 工具表：按顺序重放 `toolsRemoved`（先）与 `toolsAdded`（后），同名后者覆盖；
 * - 模态过滤：模型不收图片时，用户消息与工具结果里的图片块换成文字占位。
 *
 * 支持「中途 system 消息」的协议（compat.supportsMidConvoSystemMessages）用
 * `normalizeContextInline()`：首条非 system 消息之前的 system 折叠进系统提示，之后的补丁
 * 渲染为文本、按位置插回对话。
 */

import type {
  AssistantMessage,
  ContentBlock,
  Message,
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

class SystemState {
  readonly sections = new Map<string, string>();
  readonly tools = new Map<string, ToolDecl>();

  apply(message: SystemMessage): void {
    for (const [name, value] of Object.entries(message.sections)) {
      if (value === null) this.sections.delete(name);
      else this.sections.set(name, value);
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
  const fold = removesToolsMidway(context.messages);
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
    tools.apply(message);
    if (fold || messages.length === 0) {
      head.apply(message);
      continue;
    }
    const text = renderSystemUpdate(message);
    if (text.length > 0) pending.push(text);
  }
  flush();
  return { ...head.snapshot(), tools: tools.snapshot().tools, messages };
}

/** 对话开始之后有补丁移除了工具（这时整段前缀必然失效，补丁全部折回开头）。 */
function removesToolsMidway(transcript: readonly Message[]): boolean {
  let started = false;
  for (const message of transcript) {
    if (message.role !== "system") started = true;
    else if (started && (message.toolsRemoved?.length ?? 0) > 0) return true;
  }
  return false;
}

/** 中途节补丁作为尾部上下文消息送达时的文本（固定英文，与界面语言无关）。 */
export function systemReminderText(updates: readonly string[]): string {
  return (
    `<system-reminder>\n${updates.join("\n\n")}\n\n` +
    "These updates replace the earlier versions of those system prompt sections.\n</system-reminder>"
  );
}

/** 渲染一条中途 system 补丁的文本（节变更；工具表变化由请求的工具列表体现）。 */
export function renderSystemUpdate(message: SystemMessage): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(message.sections)) {
    parts.push(
      value === null
        ? `System prompt section "${name}" was removed.`
        : `System prompt section "${name}" was updated:\n\n${value}`,
    );
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
  for (const message of context.messages) {
    if (message.role !== "system") {
      messages.push(filterMessage(message, allowImages));
      continue;
    }
    tools.apply(message);
    if (messages.length === 0) {
      head.apply(message);
      continue;
    }
    const text = renderSystemUpdate(message);
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
