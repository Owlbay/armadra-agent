/**
 * normalizeContext（设计 §1.2 ai/context.ts）：把循环交来的转录（含 `system` 补丁消息）变成
 * 协议可直接拼请求体的形状。
 *
 * - system 折叠：按出现顺序重放全部 system 消息的 `sections`（节名级替换，null 删除），得到
 *   `systemSections`（保持节首次出现的顺序）与拼好的 `systemPrompt`（节间空一行）；
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
  const state = new SystemState();
  const messages: ConversationMessage[] = [];
  const allowImages = allowsImages(options);
  for (const message of context.messages) {
    if (message.role === "system") state.apply(message);
    else messages.push(filterMessage(message, allowImages));
  }
  return { ...state.snapshot(), messages };
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
