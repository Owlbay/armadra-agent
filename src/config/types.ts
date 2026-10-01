/**
 * 磁盘配置文件形状（设计 §3.5、§7.3、§10.2、§10.3、§12.10）。[B0] 契约文件。
 *
 * 补全与偏差：§1.2 把这些类型放在 config/schema.ts（B5），但 Runtime（cli/runtime.ts，B0）
 * 与 SDK 的 `CreateSessionOptions.config` 都要引用 `AmaConfig`，而 B5 与 B6 并行开工，
 * 所以形状在这里定死；config/schema.ts 只做校验并可再导出这些类型。
 * hooks.json 的形状是 `HookConfig`（hooks/types.ts）。
 */

import type { Api, Model, ModelThinkingLevel, ProviderCompat, AuthHeader } from "../ai/types.js";
import type { PermissionMode } from "../permissions/types.js";

export const CONFIG_FILE_VERSION = 1 as const;

/** 自定义模型条目；缺省 maxTokens 8192、reasoning false、input ["text"]，不猜 contextWindow。 */
export type ModelConfig = Partial<Omit<Model, "id" | "provider" | "api">> & { id: string };

/** 只改元数据的覆盖项。 */
export type ModelOverride = Partial<Omit<Model, "id" | "provider" | "api">> & { id: string };

export interface ProviderConfig {
  name?: string;
  /** 自定义供应商缺省 openai-completions。 */
  api?: Api;
  baseUrl?: string;
  /** 支持 "$ENV_NAME"、"${ENV_NAME}"、"!command"；"$$" 转义。 */
  apiKey?: string;
  envKeys?: string[];
  authHeader?: AuthHeader;
  headers?: Record<string, string>;
  compat?: ProviderCompat;
  requiresApiKey?: boolean;
  models?: ModelConfig[];
  modelOverrides?: ModelOverride[];
}

export interface PermissionConfig {
  mode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  /**
   * 内置 deny 表（`.git/**` 写、`.ssh/**` 读写）：缺省 true 全部启用；false 全部移除；
   * 数组 = 要移除的规则原文。放宽项，只认用户级 / profile，项目级忽略并 warning。
   */
  builtinDeny?: boolean | string[];
}

export interface CompactionConfig {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface RetryConfig {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** 工具预设（设计 §5.6）：模型直接看到的工具集合。 */
export type ToolsPreset = "default" | "minimal" | "codemode" | "coordinator";

/** 从严到宽：项目级只能把预设改成不比当前更宽的那个（coordinator 最严，codemode 最宽）。 */
export const TOOLS_PRESETS_STRICT_FIRST: readonly ToolsPreset[] = [
  "coordinator",
  "minimal",
  "default",
  "codemode",
];

export interface ToolsConfig {
  /** 缺省 `default`；命令行 `--tools-preset`。 */
  preset?: ToolsPreset;
  maxToolResultChars?: number;
  bashTimeoutMs?: number;
  disabled?: string[];
}

/** codemode 调用方式（设计 §5.5）：off 不注册；on 全部工具 + codemode；only 只有 codemode。 */
export type CodemodeMode = "off" | "on" | "only";

export const CODEMODE_MODES: readonly CodemodeMode[] = ["off", "on", "only"];

export interface CodemodeConfig {
  /** 命令行 `--codemode`；项目级只接受 "off"。 */
  mode?: CodemodeMode;
  /** `codemode` 描述里内联工具声明的总预算（估算 token，缺省 3 000），超出只列名字。 */
  inlineBudget?: number;
  /** true：运行时 Node 的权限模型不隔离网络（Node 22 / 24）时直接禁用 codemode。 */
  requireStrict?: boolean;
}

export interface HooksSettings {
  timeoutMs?: number;
}

export interface UiConfig {
  theme?: "dark" | "light";
  markdown?: boolean;
  showThinking?: "full" | "collapsed" | "hidden";
  /** 第一期只有 regular（§12.10）。 */
  tuiMode?: "regular";
  quietStartup?: "normal" | "header" | "silent";
}

export interface SkillsConfig {
  dirs?: string[];
}

/** config.json（用户级 / 项目级 / profile.config 同形状；项目级只接受受限字段，§10.2）。 */
export interface AmaConfig {
  version: typeof CONFIG_FILE_VERSION;
  /** `provider/model-id`。 */
  defaultModel?: string;
  thinkingLevel?: ModelThinkingLevel;
  providers?: Record<string, ProviderConfig>;
  permission?: PermissionConfig;
  compaction?: CompactionConfig;
  retry?: RetryConfig;
  tools?: ToolsConfig;
  codemode?: CodemodeConfig;
  hooks?: HooksSettings;
  ui?: UiConfig;
  skills?: SkillsConfig;
}

/** auth.json（0600）。 */
export interface AuthFile {
  version: typeof CONFIG_FILE_VERSION;
  providers: Record<string, { apiKey: string; env?: Record<string, string>; baseUrl?: string }>;
}

/** profile.json（宿主用，§10.3；与 Armadra 文档 B §2.4 一致）；路径必须是绝对路径，不含密钥。 */
export interface ProfileFile {
  version: typeof CONFIG_FILE_VERSION;
  host?: string;
  instructions?: string[];
  skillDirs?: string[];
  promptDirs?: string[];
  hooksFile?: string;
  authFile?: string;
  /** false：key 只来自 authFile，不读环境变量（§11.2）。 */
  authEnv?: boolean;
  sessionDir?: string;
  config?: string;
  trustProject?: boolean;
}

export interface TrustEntry {
  path: string;
  trusted: boolean;
  /** ISO 8601。 */
  at: string;
}

/** trust.json（只在用户级目录）。 */
export interface TrustFile {
  version: typeof CONFIG_FILE_VERSION;
  entries: TrustEntry[];
}
