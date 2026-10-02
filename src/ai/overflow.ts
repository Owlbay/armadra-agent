/**
 * 上下文溢出识别（设计 §3.6「溢出」）。溢出不走会话层重试，走「压缩后以新 run 重试一次」（§9）。
 *
 * 三种情形：
 * 1. 错误文案：各家 400 / 413 的报错（下表；先排除限流类文案，避免「too many tokens, please
 *    wait」被误判）；
 * 2. 静默溢出：请求成功但 `usage.input + cacheRead` 超过窗口（个别网关）；
 * 3. `stopReason: "length"` 且没有工具调用：由调用方结合 `isLengthStop()` 判断（§3.6）。
 *
 * 文案表只记录各家文档或实测中出现过的句式；新增供应商时用真实溢出请求取样后补一条。
 */

import type { AssistantMessage } from "./types.js";

/** [正则, 来源说明]。来源说明只是给维护者看的出处记录（不显示、不发给模型），统一写英文。 */
export const OVERFLOW_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/prompt is too long/i, "Anthropic: prompt is too long: N tokens > M maximum"],
  [/request_too_large/i, "Anthropic: 413 request_too_large"],
  [/exceeds the context window/i, "OpenAI: Your input exceeds the context window of this model"],
  [/maximum context length is \d+ tokens/i, "OpenAI / OpenRouter / DeepSeek"],
  [
    /exceeds (?:the )?(?:model'?s )?maximum context length/i,
    "OpenAI-compatible gateways (vLLM / LiteLLM)",
  ],
  [/input token count.*exceeds the maximum/i, "Google Gemini"],
  [
    /exceeds the maximum number of tokens allowed/i,
    "Google Gemini (variant without the input token count prefix)",
  ],
  [/maximum prompt length is \d+/i, "xAI"],
  [/reduce the length of the messages/i, "Groq"],
  [/too large for model with \d+ maximum context length/i, "Mistral"],
  [/exceeded model token limit/i, "Moonshot / Kimi"],
  [/prompt (?:too long|exceeds max length)/i, "Zhipu GLM (code 1261) / Ollama"],
  [/range of input length should be/i, "DashScope / Qwen"],
  [/greater than the context length/i, "LM Studio"],
  [/exceeds the available context size/i, "llama.cpp server"],
  [/context[_ ]length[_ ]exceeded/i, "generic: context_length_exceeded"],
  [/model_context_window_exceeded/i, "generic: finish_reason as text"],
  [/token limit exceeded/i, "generic"],
];

/** 命中这些的不算溢出（限流 / 配额）。 */
const NOT_OVERFLOW: readonly RegExp[] = [/rate[ _-]?limit/i, /too many requests/i, /\b429\b/];

/** 错误文本是否表示上下文溢出。 */
export function isOverflowErrorText(text: string): boolean {
  if (NOT_OVERFLOW.some((re) => re.test(text))) return false;
  return OVERFLOW_PATTERNS.some(([re]) => re.test(text));
}

/**
 * 助手消息是否表示上下文溢出（情形 1、2）。`contextWindow` 缺省时不判静默溢出。
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  if (message.stopReason === "error" && message.errorMessage) {
    if (isOverflowErrorText(message.errorMessage)) return true;
  }
  if (contextWindow !== undefined && contextWindow > 0 && message.stopReason === "stop") {
    if (message.usage.input + message.usage.cacheRead > contextWindow) return true;
  }
  return false;
}

/** `length` 停止且没有工具调用：§9 的「压缩后重试一次」候选。 */
export function isLengthStop(message: AssistantMessage): boolean {
  return (
    message.stopReason === "length" && !message.content.some((block) => block.type === "toolCall")
  );
}
