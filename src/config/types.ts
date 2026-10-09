/**
 * 磁盘配置文件形状（设计 §3.5、§7.3、§10.2、§10.3、§12.10）。[B0] 契约文件。
 *
 * 补全与偏差：§1.2 把这些类型放在 config/schema.ts（B5），但 Runtime（cli/runtime.ts，B0）
 * 与 SDK 的 `CreateSessionOptions.config` 都要引用 `AmaConfig`，而 B5 与 B6 并行开工，
 * 所以形状在这里定死；config/schema.ts 只做校验并可再导出这些类型。
 * hooks.json 的形状是 `HookConfig`（hooks/types.ts）。
 * （W3-C0）第三波：`cache` 段（§1.12，只认用户级 / profile）；`ModelConfig` / `ModelOverride`
 * 允许模型级 `api`（§2.3，同一中转的模型走不同协议），由 W3-B12 在注册表里生效。
 * （W5-C0）第五波配置键（docs/wave5-plan.md §9）：新段的形状在 types-w5.ts（`AmaConfigW5` 并入
 * `AmaConfig`），已有段加 `ui.statusLine`、`compaction.prune / pruneExclude`、profile `agentDirs`。
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
import type { CheckpointMode } from "../checkpoints/types.js";
import type { AmaConfigW5, PruneConfig, StatusLineMode } from "./types-w5.js";
import type { AmaConfigW6, AuthFileEntry, ProfileMemoryOptions, UiConfigW6 } from "./types-w6.js";

export type * from "./types-w5.js";
export type * from "./types-w6.js";
export {
  AGENT_BAR_MODES,
  CHATGPT_FLAVORS,
  LANGUAGE_SETTINGS,
  MEMORY_SCOPES,
  MEMORY_SUBAGENT_MODES,
  apiKeyEntry,
  isOAuthEntry,
} from "./types-w6.js";
export {
  AGENTS_RESERVED_KEYS,
  IMAGE_RESIZE_MODES,
  PLAN_BASH_MODES_STRICT_FIRST,
  PLAN_UNATTENDED_MODES,
  STATUS_LINE_MODES,
  agentEntry,
} from "./types-w5.js";

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
  /**
   * [ME-C0] 从内置目录继承模型固有属性：缺省按 id 别名自动匹配；`"provider/id"` 显式指定；false 关闭
   * （docs/model-efficiency-plan.md D10，实现归 ME-D）。
   */
  catalog?: string | false;
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
  /** [ME-C0] 软窗口（≥ 32768）：档一 / 档二 / context_pressure 的窗口取 min(模型窗口, 它)；缺省 = 模型窗口。 */
  contextBudget?: number;
  /** [W5-C0] 档一裁剪参数（W5-H1）；只认用户级。 */
  prune?: PruneConfig;
  /** [W5-C0] 不被档一裁剪的工具名（W5-H1）；只认用户级。 */
  pruneExclude?: string[];
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

export interface UiConfig extends UiConfigW6 {
  /** auto 按 `COLORFGBG` / `TERM_PROGRAM` 猜（不发查询序列），猜不出用 dark。 */
  theme?: "dark" | "light" | "auto";
  markdown?: boolean;
  showThinking?: "full" | "collapsed" | "hidden";
  /** 第一期只有 regular（§12.10）。 */
  tuiMode?: "regular";
  quietStartup?: "normal" | "header" | "silent";
  /** ASCII 字形（`AMA_ASCII=1` 等价）；缺省按区域设置 / TERM 自动检测。 */
  ascii?: boolean;
  /** 消息区块间不空行、启动头不画字符画，缺省 false。 */
  compact?: boolean;
  /** 启动头的「AMA」字符画：auto（缺省，宽度够时画）/ off（只画信息列）。 */
  logo?: "auto" | "off";
  /** false：运行中 spinner 固定为 `·`，缺省 true。 */
  animation?: boolean;
  /** 运行中 Esc 中断、本回合还没有任何输出时撤回该回合并回填原消息，缺省 true。 */
  restoreOnCancel?: boolean;
  /** 运行中按 Enter：queue（缺省）排队插话，interrupt 打断并立即发送（与 `app.message.interrupt` 互换）。 */
  enterWhileRunning?: "queue" | "interrupt";
  /** 终端程序状态 OSC 7501：auto（缺省）检测通过才发，on 不检测直接发，off 不发。 */
  programStatus?: "auto" | "on" | "off";
  /** [W5-C0] 底部信息行（W5-A）：缺省独立终端 full、嵌入宿主（有 profile）compact。 */
  statusLine?: StatusLineMode;
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
  /** 等响应头的最长时间（毫秒）；缺省 300 000，0 关闭。流中的间隔见 `streamIdleTimeoutMs`。 */
  idleTimeoutMs?: number;
  /**
   * [ME-C0] 流中两块数据之间的最长间隔（毫秒）；缺省 180 000，0 关闭；环境变量
   * `AMA_STREAM_IDLE_TIMEOUT_MS` 覆盖（cli/compose-request.ts）。
   */
  streamIdleTimeoutMs?: number;
}

/** [ME-C0] `compaction.contextBudget` 的下限。 */
export const MIN_CONTEXT_BUDGET = 32_768;
/** [ME-C0] `request.streamIdleTimeoutMs` 的缺省（毫秒）。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;

export const CHECKPOINT_MODES: readonly CheckpointMode[] = ["tools", "shadow-git", "off"];

/**
 * 检查点（docs/rewind-plan.md §5）。环境变量 `AMA_CHECKPOINTS` 覆盖 `mode`；项目级只接受
 * `mode: "off"` 与调小 `maxFileBytes`（只能收紧）。
 */
export interface CheckpointsConfig {
  /** tools（缺省）：跟踪 edit / write 改过的文件；shadow-git：影子 git（RW-D）；off：关闭。 */
  mode?: CheckpointMode;
  /** 单个文件的备份上限（字节），超出不备份，回滚时报告无法恢复；缺省 5 242 880。 */
  maxFileBytes?: number;
  /** 可回滚的最近检查点数，缺省 100。 */
  keep?: number;
}

export const DEFAULT_CHECKPOINTS_CONFIG: Readonly<Required<CheckpointsConfig>> = Object.freeze({
  mode: "tools",
  maxFileBytes: 5_242_880,
  keep: 100,
});

export const SANDBOX_ENABLED_MODES: readonly ("auto" | "off")[] = ["auto", "off"];
/** [S2] `sandbox.network` 的取值。 */
export const SANDBOX_NETWORK_MODES: readonly ("deny" | "allow")[] = ["deny", "allow"];

/**
 * 操作系统级沙箱（docs/sandbox.md）。只认用户级 / profile；项目级只接受收紧的 `network: "deny"`，其余忽略
 * 并 warning。环境变量 `AMA_SANDBOX=off` 覆盖 `enabled`。
 */
export interface SandboxConfig {
  /** auto（缺省）：探测到可用的 sandbox-exec / bwrap / unshare 就用；off：不用。 */
  enabled?: "auto" | "off";
  /** [S2] bash 经 OS 沙箱运行：auto 有 sandbox-exec / bwrap 就用；off（缺省）不用。 */
  bash?: "auto" | "off";
  /** [S2] bash 沙箱里的网络：deny（缺省，满足 default 模式免审批的条件）/ allow。 */
  network?: "deny" | "allow";
  /** [S2] bash 沙箱追加的可写目录（绝对路径或 `~/…`）。 */
  writable?: string[];
}

/** config.json（用户级 / 项目级 / profile.config 同形状；项目级只接受受限字段，§10.2）。 */
export interface AmaConfig extends AmaConfigW5, AmaConfigW6 {
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
  checkpoints?: CheckpointsConfig;
  sandbox?: SandboxConfig;
}

/** auth.json（0600）。[W6-C0] 条目可以是 API key 或 OAuth（`isOAuthEntry` / `apiKeyEntry` 区分）。 */
export interface AuthFile {
  version: typeof CONFIG_FILE_VERSION;
  providers: Record<string, AuthFileEntry>;
}

/** profile.json（宿主用，§10.3；与 Armadra 文档 B §2.4 一致）；路径必须是绝对路径，不含密钥。 */
export interface ProfileFile {
  version: typeof CONFIG_FILE_VERSION;
  host?: string;
  instructions?: string[];
  skillDirs?: string[];
  promptDirs?: string[];
  /** [W5-C0] 子 Agent 定义目录（发现顺序在 `--agent-dir` 之后、用户级之前，W5-G）。 */
  agentDirs?: string[];
  hooksFile?: string;
  authFile?: string;
  /** false：key 只来自 authFile，不读环境变量（§11.2）。 */
  authEnv?: boolean;
  sessionDir?: string;
  config?: string;
  trustProject?: boolean;
  /** [W6-C0] 宿主界面语言（跟随画布）；优先于配置的 `ui.language`，`AMA_LANG` / `--lang` 仍更优先。 */
  language?: "zh" | "en";
  /** [W6-C0] 记忆（W6-M）：缺省禁用；`enabled: true` 时 `dir` 必填（按工作空间隔离的绝对路径）。 */
  memory?: ProfileMemoryOptions;
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
