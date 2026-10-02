/**
 * 内置供应商（设计 §3.3、docs/wave5-plan.md §3.2）。这里只放供应商级数据；模型来自 catalog/*.json，
 * compat 由各协议的 detectCompat 推断（openai-compat.ts、anthropic-compat.ts 的主机表），这里只写推断
 * 不出来的东西。
 *
 * 内置渠道（[W5-M2]）：一家同时开放多种协议时写 `channels`（首个不一定是缺省，看 `defaultChannel`）。
 * registry 物化时与用户 config 的 `channels` 合并（同名字段级覆盖、新名追加），用户的 `defaultChannel`
 * 优先。供应商级 `api` + `baseUrl` 是**单渠道回落**：用户（config / auth.json / `*_BASE_URL`）把
 * baseUrl 改到别处时内置渠道整体作废，按这一对单渠道处理（与引入内置渠道之前的行为一致）。
 * 只做按量计费端点；Coding Plan 类订阅端点不做内置渠道（D9），见 docs/providers.md。
 *
 * `baseUrlEnv`（第三波 §2.3）：通行约定的 baseUrl 环境变量（OpenAI SDK 的 `OPENAI_BASE_URL`、
 * Claude Code 的 `ANTHROPIC_BASE_URL`），设了就把内置供应商指向中转站，零配置可用；优先级低于
 * config.json 与 auth.json 的 baseUrl。
 */

import type { Api, ProviderChannel, ProviderData } from "../types.js";

export type BuiltinProvider = Omit<ProviderData, "models" | "builtin"> & {
  baseUrlEnv?: string;
  /**
   * 单渠道回落时目录模型的协议（缺省同 `api`）：OpenAI / xAI 的目录模型在中转上仍走 Responses，
   * 目录外的 id（本地服务、中转自有模型）走 `api`（Chat）。
   */
  catalogApi?: Api;
};

function ch(
  name: string,
  api: Api,
  baseUrl: string,
  extra: Omit<ProviderChannel, "name" | "api" | "baseUrl"> = {},
): ProviderChannel {
  return { name, api, baseUrl, ...extra };
}

const CHAT = "openai-completions";
const MESSAGES = "anthropic-messages";
const RESPONSES = "openai-responses";
/** 文档写 `Authorization: Bearer` 的 Anthropic 兼容端点（Kimi、MiniMax、阶跃）。 */
const BEARER = { authHeader: "authorization-bearer" } as const;

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
    catalogApi: RESPONSES,
    baseUrl: "https://api.openai.com/v1",
    // 全部模型缺省 Responses（R1 §2.3）；Chat 作渠道
    channels: [
      ch("responses", RESPONSES, "https://api.openai.com/v1"),
      ch("chat", CHAT, "https://api.openai.com/v1"),
    ],
    defaultChannel: "responses",
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
    // 实测门（wave5-plan §3.2）未过前缺省 chat；messages 上 cache_control 被忽略
    channels: [
      ch("chat", CHAT, "https://api.deepseek.com"),
      ch("messages", MESSAGES, "https://api.deepseek.com/anthropic"),
    ],
    defaultChannel: "chat",
    envKeys: ["DEEPSEEK_API_KEY", "AMA_API_KEY_DEEPSEEK"],
    requiresApiKey: true,
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    // 实测门未过前缺省 chat（K3 在 Messages 端点有 tool_use.id 复用的第三方报告）
    channels: [
      ch("chat", CHAT, "https://api.moonshot.cn/v1"),
      ch("messages", MESSAGES, "https://api.moonshot.cn/anthropic", BEARER),
      ch("responses", RESPONSES, "https://api.moonshot.cn/v1"),
      ch("chat-intl", CHAT, "https://api.moonshot.ai/v1"),
      ch("messages-intl", MESSAGES, "https://api.moonshot.ai/anthropic", BEARER),
    ],
    defaultChannel: "chat",
    envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY", "AMA_API_KEY_MOONSHOT"],
    requiresApiKey: true,
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    // 实测门未过前缺省 chat；只有隐式缓存
    channels: [
      ch("chat", CHAT, "https://open.bigmodel.cn/api/paas/v4"),
      ch("messages", MESSAGES, "https://open.bigmodel.cn/api/anthropic"),
      ch("chat-intl", CHAT, "https://api.z.ai/api/paas/v4"),
      ch("messages-intl", MESSAGES, "https://api.z.ai/api/anthropic"),
    ],
    defaultChannel: "chat",
    envKeys: ["ZHIPU_API_KEY", "ZAI_API_KEY", "AMA_API_KEY_ZHIPU"],
    requiresApiKey: true,
  },
  {
    id: "dashscope",
    name: "Alibaba DashScope (Qwen)",
    api: "openai-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    // Messages 端点执行 cache_control（5m），直接切
    channels: [
      ch("messages", MESSAGES, "https://dashscope.aliyuncs.com/apps/anthropic"),
      ch("responses", RESPONSES, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
      ch("chat", CHAT, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
      ch("messages-intl", MESSAGES, "https://dashscope-intl.aliyuncs.com/apps/anthropic"),
      ch("chat-intl", CHAT, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
    ],
    defaultChannel: "messages",
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
      "HTTP-Referer": "https://github.com/Owlbay/armadra-agent",
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
    catalogApi: RESPONSES,
    baseUrl: "https://api.x.ai/v1",
    // 官方已把 Anthropic 兼容标为 deprecated，不做 messages 渠道
    channels: [
      ch("responses", RESPONSES, "https://api.x.ai/v1"),
      ch("chat", CHAT, "https://api.x.ai/v1"),
    ],
    defaultChannel: "responses",
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
    id: "minimax",
    name: "MiniMax",
    api: "openai-completions",
    baseUrl: "https://api.minimax.cn/v1",
    // 官方推荐 Anthropic 兼容端点；M2.x 执行 cache_control（5m），M3 的缓存行为列入实测；Responses 只有 M3
    channels: [
      ch("messages", MESSAGES, "https://api.minimax.cn/anthropic", BEARER),
      ch("responses", RESPONSES, "https://api.minimax.cn/v1"),
      ch("chat", CHAT, "https://api.minimax.cn/v1"),
      ch("messages-intl", MESSAGES, "https://api.minimax.io/anthropic", BEARER),
      ch("chat-intl", CHAT, "https://api.minimax.io/v1"),
    ],
    defaultChannel: "messages",
    envKeys: ["MINIMAX_API_KEY", "AMA_API_KEY_MINIMAX"],
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

/** 内置供应商的官方主机（单渠道回落 + 全部内置渠道）。 */
export function builtinHosts(providerId: string): Set<string> {
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === providerId);
  const urls = [builtin?.baseUrl, ...(builtin?.channels ?? []).map((c) => c.baseUrl)];
  return new Set(urls.map((url) => (url ? hostOf(url) : undefined)).filter((h) => h !== undefined));
}

/**
 * 内置供应商的 baseUrl 是否被改到了非官方主机（中转站）：此时目录外的 model id 也接受，
 * compat 走保守缺省。按渠道比较主机：落在任一内置渠道的主机上（如国际站）不算中转。
 * 非内置供应商与本地服务返回 false。
 */
export function isRelayedBaseUrl(providerId: string, baseUrl: string): boolean {
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === providerId);
  if (builtin === undefined || builtin.requiresApiKey === false) return false;
  const host = hostOf(baseUrl);
  return host === undefined || !builtinHosts(providerId).has(host);
}

/** 自定义供应商的兜底环境变量名：`AMA_API_KEY_<ID>`（非字母数字转下划线、大写）。 */
export function fallbackEnvKey(providerId: string): string {
  return `AMA_API_KEY_${providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}
