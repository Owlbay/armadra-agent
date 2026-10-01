/**
 * 13 家内置供应商（设计 §3.3）。这里只放供应商级数据；模型来自 catalog/*.json，compat 由
 * 各协议的 detectCompat 推断（openai-compat.ts 的推断表），这里只写推断不出来的东西。
 *
 * google 的协议是 google-generative-ai（B8 实现）；B8 之前 registry 里没有该协议实现，
 * 调用会得到「协议未注册」的错误，过渡期请经 openrouter 调 Gemini（§17 待定项，B1 的决定：
 * 不把 google 临时改走 OpenAI 兼容端点，避免目录数据随 B8 再迁一次）。
 */

import type { ProviderData } from "../types.js";

type BuiltinProvider = Omit<ProviderData, "models" | "builtin">;

export const BUILTIN_PROVIDERS: readonly BuiltinProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    envKeys: ["ANTHROPIC_API_KEY", "AMA_API_KEY_ANTHROPIC"],
    authHeader: "x-api-key",
    requiresApiKey: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    envKeys: ["OPENAI_API_KEY", "AMA_API_KEY_OPENAI"],
    requiresApiKey: true,
  },
  {
    id: "google",
    name: "Google Gemini",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "AMA_API_KEY_GOOGLE"],
    authHeader: "x-goog-api-key",
    requiresApiKey: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    envKeys: ["DEEPSEEK_API_KEY", "AMA_API_KEY_DEEPSEEK"],
    requiresApiKey: true,
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY", "AMA_API_KEY_MOONSHOT"],
    requiresApiKey: true,
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    envKeys: ["ZHIPU_API_KEY", "ZAI_API_KEY", "AMA_API_KEY_ZHIPU"],
    requiresApiKey: true,
  },
  {
    id: "dashscope",
    name: "Alibaba DashScope (Qwen)",
    api: "openai-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKeys: ["DASHSCOPE_API_KEY", "QWEN_API_KEY", "AMA_API_KEY_DASHSCOPE"],
    requiresApiKey: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    envKeys: ["OPENROUTER_API_KEY", "AMA_API_KEY_OPENROUTER"],
    headers: {
      "HTTP-Referer": "https://github.com/yovinchen/armadra-agent",
      "X-Title": "ama",
    },
    requiresApiKey: true,
  },
  {
    id: "groq",
    name: "Groq",
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    envKeys: ["GROQ_API_KEY", "AMA_API_KEY_GROQ"],
    requiresApiKey: true,
  },
  {
    id: "xai",
    name: "xAI",
    api: "openai-completions",
    baseUrl: "https://api.x.ai/v1",
    envKeys: ["XAI_API_KEY", "AMA_API_KEY_XAI"],
    requiresApiKey: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    api: "openai-completions",
    baseUrl: "https://api.mistral.ai/v1",
    envKeys: ["MISTRAL_API_KEY", "AMA_API_KEY_MISTRAL"],
    requiresApiKey: true,
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    envKeys: ["OLLAMA_API_KEY", "AMA_API_KEY_OLLAMA"],
    requiresApiKey: false,
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1234/v1",
    envKeys: ["AMA_API_KEY_LMSTUDIO"],
    requiresApiKey: false,
  },
];

/** 自定义供应商的兜底环境变量名：`AMA_API_KEY_<ID>`（非字母数字转下划线、大写）。 */
export function fallbackEnvKey(providerId: string): string {
  return `AMA_API_KEY_${providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}
