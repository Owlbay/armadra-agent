/**
 * 磁盘配置文件形状（设计 §3.5、§7.3、§10.2、§10.3、§12.10）。[B0] 契约文件。
 *
 * 补全与偏差：§1.2 把这些类型放在 config/schema.ts（B5），但 Runtime（cli/runtime.ts，B0）
 * 与 SDK 的 `CreateSessionOptions.config` 都要引用 `AmaConfig`，而 B5 与 B6 并行开工，
 * 所以形状在这里定死；config/schema.ts 只做校验并可再导出这些类型。
 * hooks.json 的形状是 `HookConfig`（hooks/types.ts）。
 * （W3-C0）第三波：`cache` 段（§1.12，只认用户级 / profile）；`ModelConfig` / `ModelOverride`
 * 允许模型级 `api`（§2.3，同一中转的模型走不同协议），由 W3-B12 在注册表里生效。
 */

import type { WarmingMode } from "../ai/cache/types.js";
import type {
  Api,
  AuthHeader,
  CacheRetention,
  Model,
  ModelThinkingLevel,
  ProviderCompat,
} from "../ai/types.js";
import type { PermissionMode } from "../permissions/types.js";

export const CONFIG_FILE_VERSION = 1 as const;

/**
 * 自定义模型条目；缺省 maxTokens 8192、reasoning false、input ["text"]，不猜 contextWindow。
 * `api` 缺省沿用供应商的协议。
 */
export type ModelConfig = Partial<Omit<Model, "id" | "provider" | "channel" | "channels">> & {
  id: string;
  /** 挂载的渠道名，第一个是首选；缺省 `defaultChannel`（docs/providers.md「渠道」）。 */
  channels?: string[];
  /** models.dev 条目 `provider/model`（显式匹配）；false 关闭 models.dev 补全。 */
  modelsDev?: string | false;
};

/** 只改元数据的覆盖项（含模型级 `api` 与 `channels`）。 */
export type ModelOverride = ModelConfig;

/** 渠道：协议 + 地址（+ 可选 key / headers / compat），缺省继承供应商级。 */
export interface ChannelConfig {
  api: Api;
  baseUrl: string;
  /** 同供应商级 `apiKey` 的写法；缺省用供应商的 key。 */
  apiKey?: string;
  authHeader?: AuthHeader;
  headers?: Record<string, string>;
  compat?: ProviderCompat;
}

/** 渠道名：不含 `/` 与 `@`（`provider/model@channel`）。 */
export const CHANNEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

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
  /** 多渠道（docs/providers.md「渠道」）；不写时 `api` + `baseUrl` 是隐式的 `default` 渠道。 */
  channels?: Record<string, ChannelConfig>;
  /** 缺省 `channels` 的第一个键。 */
  defaultChannel?: string;
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
  /** auto 模式分类器的模型（`provider/model`）；缺省 = 当前会话模型。放宽项，项目级忽略。 */
  autoModel?: string;
  /** auto 模式安全名单追加（词前缀或含 `*` 的通配）。放宽项，项目级忽略；各层累加。 */
  autoSafeCommands?: string[];
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

/** 工具预设（设计 §5.6）：模型直接看到的工具集合（规范名）。 */
export type ToolsPreset = "default" | "minimal" | "codemode-only" | "coordinator";

/** 预设别名 → 规范名：`codemode` 是 0.3.0 的旧名（行为同 `codemode-only`）。 */
export const TOOLS_PRESET_ALIASES: Readonly<Record<string, ToolsPreset>> = Object.freeze({
  codemode: "codemode-only",
});

/** 配置文件、命令行、RPC、SDK 接受的写法：规范名或别名。 */
export type ToolsPresetInput = ToolsPreset | "codemode";

/** 从严到宽：项目级只能把预设改成不比当前更宽的那个（coordinator 最严，codemode-only 最宽）。 */
export const TOOLS_PRESETS_STRICT_FIRST: readonly ToolsPreset[] = [
  "coordinator",
  "minimal",
  "default",
  "codemode-only",
];

/** 全部可接受的写法（规范名在前，别名在后；schema 与命令行校验用）。 */
export const TOOLS_PRESET_INPUTS: readonly ToolsPresetInput[] = [
  ...TOOLS_PRESETS_STRICT_FIRST,
  "codemode",
];

/** 规范名；未知名字原样返回（校验由 schema 负责）。 */
export function canonicalPreset(name: ToolsPresetInput): ToolsPreset;
export function canonicalPreset(name: string | undefined): ToolsPreset | undefined;
export function canonicalPreset(name: string | undefined): ToolsPreset | undefined {
  if (name === undefined) return undefined;
  return Object.hasOwn(TOOLS_PRESET_ALIASES, name)
    ? (TOOLS_PRESET_ALIASES[name] as ToolsPreset)
    : (name as ToolsPreset);
}

export interface ToolsConfig {
  /** 缺省 `default`；命令行 `--tools-preset`；`codemode` 是 `codemode-only` 的别名。 */
  preset?: ToolsPresetInput;
  /**
   * 在预设上微调（设计 §5.6）：`+name` 加、`-name` 去；不带前缀的名字整组替换预设的内置工具。
   * 只认用户级 / profile（项目级忽略并 warning）。
   */
  default?: string[];
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

export const CACHE_RETENTIONS: readonly CacheRetention[] = ["none", "short", "long"];

/**
 * 缓存（第三波 §1.12）。整段只认用户级 / profile，项目级忽略并 warning（同 `permission.allow`）；
 * 环境变量 `AMA_CACHE_WARMING` / `AMA_CACHE_RETENTION` 覆盖对应项。
 */
export interface CacheConfig {
  /** off | streaming | idle，缺省 streaming。 */
  warming?: WarmingMode;
  /** none | short | long，缺省 short。 */
  retention?: CacheRetention;
  /** 保温的最低期望节省（美元），缺省 0.05。 */
  minSavingsUsd?: number;
  /** 转录 / 消息区的未命中与上下文余量提示，缺省 true（统计面板不受影响）。 */
  missNotices?: boolean;
  /** 子会话（task）也保温，缺省 false。 */
  warmSubagents?: boolean;
}

export const DEFAULT_CACHE_CONFIG: Readonly<Required<CacheConfig>> = Object.freeze({
  warming: "streaming",
  retention: "short",
  minSavingsUsd: 0.05,
  missNotices: true,
  warmSubagents: false,
});

/**
 * 模型请求（W4-C）。只认用户级 / profile；环境变量 `AMA_IDLE_TIMEOUT_MS` 覆盖 `idleTimeoutMs`。
 */
export interface RequestConfig {
  /** 等响应头与流中两块数据之间的最长间隔（毫秒），收到任何字节即重新计时；缺省 300 000，0 关闭。 */
  idleTimeoutMs?: number;
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
  cache?: CacheConfig;
  request?: RequestConfig;
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
