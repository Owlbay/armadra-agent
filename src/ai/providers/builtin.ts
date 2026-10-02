/**
 * 13 家内置供应商（设计 §3.3）。这里只放供应商级数据；模型来自 catalog/*.json，compat 由
 * 各协议的 detectCompat 推断（openai-compat.ts 的推断表），这里只写推断不出来的东西。
 *
 * 这里的 `api` 是供应商级缺省；目录条目可用 `api` 覆盖（openai 推理模型与 xai 目录模型走
 * openai-responses，见 catalog/*.json）。
 *
 * `baseUrlEnv`（第三波 §2.3）：通行约定的 baseUrl 环境变量（OpenAI SDK 的 `OPENAI_BASE_URL`、
 * Claude Code 的 `ANTHROPIC_BASE_URL`），设了就把内置供应商指向中转站，零配置可用；优先级低于
 * config.json 与 auth.json 的 baseUrl。
 */

import type { ProviderData } from "../types.js";

export type BuiltinProvider = Omit<ProviderData, "models" | "builtin"> & { baseUrlEnv?: string };

export const BUILTIN_PROVIDERS: readonly BuiltinProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    envKeys: ["ANTHROPIC_API_KEY", "AMA_API_KEY_ANTHROPIC"],
    authHeader: "x-api-key",
    requiresApiKey: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
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

/** 主机名（不含端口）；无法解析时返回 undefined。 */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * 内置供应商的 baseUrl 是否被改到了非官方主机（中转站）：此时目录外的 model id 也接受，
 * compat 走保守缺省。非内置供应商返回 false。
 */
export function isRelayedBaseUrl(providerId: string, baseUrl: string): boolean {
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === providerId);
  if (builtin === undefined || builtin.requiresApiKey === false) return false;
  return hostOf(baseUrl) !== hostOf(builtin.baseUrl);
}

/** 自定义供应商的兜底环境变量名：`AMA_API_KEY_<ID>`（非字母数字转下划线、大写）。 */
export function fallbackEnvKey(providerId: string): string {
  return `AMA_API_KEY_${providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}
