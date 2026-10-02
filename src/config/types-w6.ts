/**
 * 第六波配置键的形状（docs/wave6-plan.md §7、§1.3、§3.1、§4.3、§4.4、§5.2）。[W6-C0] 契约文件：C0 只定形状、
 * 校验（schema-w6.ts）、说明与缺省（key-docs.ts）、JSON Schema；行为由各批次实现，未实现前这些键被接受但不起作用。
 *
 * 层级（merge.ts）：项目级可设 `ui.language`、`ui.agentBar`，`memory` 只接受 `enabled: false`；`ui.replyLanguage`、
 * `memory` 其余键、`auth` 只认用户级 / profile（项目级忽略并 warning）。
 */

/** `ui.language`：auto 按 `LC_ALL` / `LC_MESSAGES` / `LANG` 判断，判断不出用 en（docs/i18n.md）。 */
export type LanguageSetting = "auto" | "zh" | "en";
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["auto", "zh", "en"];

/** [W6-A] Agent 栏：auto 有任务时显示；off 不显示（嵌入宿主缺省 off）。 */
export type AgentBarMode = "auto" | "off";
export const AGENT_BAR_MODES: readonly AgentBarMode[] = ["auto", "off"];

/** 第六波在 `ui` 段新增的键。 */
export interface UiConfigW6 {
  /** 界面语言，缺省 auto；`AMA_LANG` / `--lang` 覆盖；项目级可设。 */
  language?: LanguageSetting;
  /**
   * [D22] 模型回复语言（如 `Chinese`）：设置时会话开始在 `rules` 节末尾追加一句英文规则；不设零字节变化。
   * 只认用户级 / profile。
   */
  replyLanguage?: string;
  /** [W6-A] Agent 栏，缺省 auto；嵌入宿主（有 profile）缺省 off。 */
  agentBar?: AgentBarMode;
}

/** [W6-M] 记忆作用域：独立终端 user / project；嵌入宿主只有 workspace（profile.memory.dir）。 */
export type MemoryScopeName = "user" | "project";
export const MEMORY_SCOPES: readonly MemoryScopeName[] = ["user", "project"];
export const MEMORY_SUBAGENT_MODES = ["off", "read"] as const;

/** [W6-M] `memory` 段（docs/wave6-plan.md §3.1）。缺省关闭；关闭时系统提示、工具表、请求体逐字节不变。 */
export interface MemoryConfig {
  /** 总开关，缺省 false；项目级只能设为 false；`--memory` / `--no-memory`、`AMA_MEMORY=0|1` 覆盖。 */
  enabled?: boolean;
  /** 启用的作用域，缺省 ["user", "project"]。 */
  scopes?: MemoryScopeName[];
  /** 每作用域索引注入的硬顶（字节），缺省 4096。 */
  indexMaxBytes?: number;
  /** 单条记忆上限（字节），超出拒写，缺省 16384。 */
  fileMaxBytes?: number;
  /** 每作用域条目上限，缺省 200。 */
  maxFiles?: number;
  /** 子会话：read（缺省，写命令执行层拒绝）/ off（view 也拒绝）。 */
  subagents?: (typeof MEMORY_SUBAGENT_MODES)[number];
}

/** [W6-O] ChatGPT 登录的两条路径（docs/wave6-plan.md §4.1、D13）。 */
export type ChatGptFlavor = "siwc" | "codex";
export const CHATGPT_FLAVORS: readonly ChatGptFlavor[] = ["siwc", "codex"];

/** [W6-O] `auth.chatgpt`：不含密钥；只认用户级 / profile。 */
export interface ChatGptAuthConfig {
  /** 缺省 siwc（官方动态注册）；codex 是显式开启的备用。 */
  flavor?: ChatGptFlavor;
  clientId?: string;
  issuer?: string;
  /** codex flavor 的 `originator` 请求头，缺省 codex_cli_rs。 */
  originator?: string;
  /** 本地回调端口（依次尝试；0 = 任意空闲端口）。 */
  redirectPorts?: number[];
}

/** [W6-O] `auth` 段。 */
export interface AuthConfig {
  chatgpt?: ChatGptAuthConfig;
}

/** 第六波并入 `AmaConfig` 的顶层段。 */
export interface AmaConfigW6 {
  memory?: MemoryConfig;
  auth?: AuthConfig;
}

/**
 * [W6-M] profile / SDK 的 `memory`（D11）：嵌入宿主缺省禁用；`enabled: true` 时 `dir` 必填（绝对路径），
 * 作用域只有 `workspace`，不读用户级记忆。
 */
export interface ProfileMemoryOptions {
  enabled: boolean;
  dir?: string;
}

/** auth.json 里的 API key 条目（第一期起的形态）。 */
export interface ApiKeyAuthEntry {
  apiKey: string;
  env?: Record<string, string>;
  baseUrl?: string;
}

/**
 * [W6-O] auth.json 里的 OAuth 条目（docs/wave6-plan.md §4.3、D15）。token 与 id_token 原文绝不进日志、错误、
 * 事件、会话；`describeAuthFile` 只给 `{ kind: "oauth", flavor, plan, expiresIn, needsLogin }`。
 */
export interface OAuthAuthEntry {
  type: "oauth";
  flavor: ChatGptFlavor;
  clientId?: string;
  issuer?: string;
  accountId?: string;
  planType?: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** epoch ms。 */
  expiresAt: number;
  /** ISO 8601。 */
  lastRefresh?: string;
  /** codex flavor 首次登录的非官方用法确认时刻（ISO 8601）。 */
  acknowledgedAt?: string;
  /** 刷新永久失败：保留 token，等用户重新登录（错误 `auth_expired`）。 */
  needsLogin?: boolean;
}

export type AuthFileEntry = ApiKeyAuthEntry | OAuthAuthEntry;

export function isOAuthEntry(entry: AuthFileEntry | undefined): entry is OAuthAuthEntry {
  return entry !== undefined && (entry as { type?: unknown }).type === "oauth";
}

/** API key 条目（OAuth 条目返回 undefined）。 */
export function apiKeyEntry(entry: AuthFileEntry | undefined): ApiKeyAuthEntry | undefined {
  return entry === undefined || isOAuthEntry(entry) ? undefined : entry;
}
