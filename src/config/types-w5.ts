/**
 * 第五波配置键的形状（docs/history/wave5-plan.md §9）。[W5-C0] 契约文件：C0 只定形状、校验（schema-w5.ts）、
 * 说明与缺省（key-docs.ts）、JSON Schema；行为由各批次实现，未实现前这些键被接受但不起作用。
 *
 * 层级：项目级只接受 `plan.bash`（只能更严）、`reminders`、`ui.statusLine`（随 `ui` 段）；其余只认
 * 用户级 / profile（项目级忽略并 warning，merge.ts）。
 */

import type { ModelThinkingLevel } from "../ai/types.js";
import type { PermissionMode } from "../permissions/types.js";

/** [W5-A] 底部信息行：full 两行（速率行 + 状态行），compact 一行。 */
export type StatusLineMode = "full" | "compact";
export const STATUS_LINE_MODES: readonly StatusLineMode[] = ["full", "compact"];

/** [W5-I] 图像。 */
export interface ImagesConfig {
  /** auto：超限时用系统工具（sips / magick）缩放，没有工具按原规则拒绝；off：从不缩放。 */
  resize?: "auto" | "off";
}
export const IMAGE_RESIZE_MODES = ["auto", "off"] as const;

/** plan 模式下 bash 的处理，从严到宽。 */
export type PlanBashMode = "deny" | "readonly" | "ask";
export const PLAN_BASH_MODES_STRICT_FIRST: readonly PlanBashMode[] = ["deny", "readonly", "ask"];

/** [W5-F] Plan。 */
export interface PlanConfig {
  /** 缺省 readonly：只读命令放行、其余拒绝；ask：其余询问；deny：bash 全拒。项目级只能更严。 */
  bash?: PlanBashMode;
  /** 计划文件目录（必须在项目根之内）；缺省 `<dataDir>/plans`。 */
  directory?: string;
  /** 无人值守（`-p`、RPC 未声明 plans 能力）时：stop 落盘后停下（缺省），approve 自动批准执行。 */
  unattended?: "stop" | "approve";
  /** 规划用模型 `provider/model[@channel]`：进入 plan 时切换、批准时切回。 */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
}
export const PLAN_UNATTENDED_MODES = ["stop", "approve"] as const;

/** [W5-E / W5-G] 单个 Agent（外部 CLI 或子 Agent 类型）的设置：`agents.<id>`。 */
export interface AgentEntryConfig {
  /** 该 Agent 的并发上限（claude 缺省 2）。 */
  maxConcurrent?: number;
  /** 允许比 ama 当前模式更宽的上限（只认用户级）。 */
  maxMode?: PermissionMode;
  /** 该类型 / 外部 Agent 使用的模型。 */
  model?: string;
  env?: {
    /** 子进程环境缺省剥离供应商 key、`*_BASE_URL` 与 `AMA_*`；这里列出要放回的变量名。 */
    passthrough?: string[];
  };
}

/** `agents` 段里的保留键（其余键都是 Agent id）。 */
export const AGENTS_RESERVED_KEYS = ["maxConcurrent", "sessionBudgetUsd", "dirs"] as const;

/** [W5-E / W5-G] `agents`：外部 Agent 与子 Agent 定义。 */
export interface AgentsConfig {
  /** 外部 Agent 总并发，缺省 3。 */
  maxConcurrent?: number;
  /** 本会话外部 Agent 的美元预算；缺省不限。 */
  sessionBudgetUsd?: number;
  /** 追加的子 Agent 定义目录；各层累加。 */
  dirs?: string[];
  [agentId: string]: AgentEntryConfig | number | string[] | undefined;
}

/** 取 `agents.<id>`（保留键返回 undefined）。 */
export function agentEntry(
  agents: AgentsConfig | undefined,
  agentId: string,
): AgentEntryConfig | undefined {
  if (agents === undefined || (AGENTS_RESERVED_KEYS as readonly string[]).includes(agentId))
    return undefined;
  const entry = agents[agentId];
  return typeof entry === "object" && !Array.isArray(entry) ? entry : undefined;
}

/** [W7-B2] 子 Agent 缺省前台还是后台（docs/history/agents-concurrency-plan.md §2.6）。 */
export const SUBAGENT_BACKGROUND_MODES = ["auto", "always", "never"] as const;
export type SubagentBackgroundMode = (typeof SUBAGENT_BACKGROUND_MODES)[number];

/** [W5-G] ama 自己的子会话。 */
export interface SubagentsConfig {
  /** 同时运行的子会话，缺省 4。 */
  maxConcurrent?: number;
  /** 排队上限，缺省 16（超出报错）。 */
  maxPending?: number;
  /** 子会话缺省模型；不设继承父会话。 */
  defaultModel?: string;
  /**
   * [W7-B2] task 缺省后台：auto（缺省）= 交互 / RPC / ACP 下后台、`-p` 下前台；always / never 固定。
   * 优先级：调用参数 > 类型定义 > 本键。用户 / 项目 / 宿主级都认。
   */
  background?: SubagentBackgroundMode;
  /** [W7-B2] 前台任务运行超过该毫秒数自动转后台；缺省 0 关闭。用户 / 项目级都认。 */
  autoBackgroundAfterMs?: number;
  /** [M-F] 已结束子会话保留在内存的句柄数（LRU），缺省 4；超出的续聊时从会话文件重开。只认用户级。 */
  retainSessions?: number;
  /**
   * [#149] fork 回落比例：父上一次请求的输入 token 超过（窗口 − compaction.reserveTokens）× 本值时
   * fork 回落为 fresh；0.05–0.95，缺省 0.5。只认用户级。
   */
  forkMaxContextRatio?: number;
}

/** `models.enabled` 的一项：`provider/model[@channel]` 或 `provider/*`。 */
export const MODELS_ENABLED_REF = /^[^/\s]+\/\S+$/;

/** [W5-G] 模型别名（子 Agent 定义的 `model: fast | strong`）。 */
export interface ModelsConfig {
  aliases?: { fast?: string; strong?: string };
  /**
   * 模型选择器的显式清单（`provider/model[@channel]`，`provider/*` 整个供应商）：设置后 `/model` 只显示清单内
   * 的模型（加当前模型）；不设时显示已配置 key / 登录 / 本地可达的供应商的全部模型。只认用户级。
   */
  enabled?: string[];
}

/** [W5-H1] 档一裁剪参数（其余随窗口缩放的常量不暴露）。 */
export interface PruneConfig {
  /** 保留最近 N 个工具结果，缺省 5。 */
  keepResults?: number;
  /** 一次至少能省多少 token 才裁：auto = max(20k, 0.1×预算)。 */
  clearAtLeast?: "auto" | number;
}

/** [W5-H2] 会话预算（`--max-turns` / `--max-cost` 覆盖）。 */
export interface LimitsConfig {
  maxTurns?: number;
  maxCostUsd?: number;
}

/** [W5-H2] 提醒通道 `ama.reminder` 的各项开关（缺省全开）。 */
export interface RemindersConfig {
  /** 连续多回合未更新 todo 且有未完成项时复述。 */
  todo?: boolean;
  /** 读过的文件被外部改动时列出。 */
  fileChanges?: boolean;
  /** 上下文用量 70% / 85% 各提醒一次。 */
  contextPressure?: boolean;
  /** 预算剩余 < 20% 时提醒。 */
  budget?: boolean;
}

/** [W5-F / W5-H2] todo。 */
export interface TodoConfig {
  /** 连续 N 回合未更新且有未完成项时提醒复述，缺省 10；0 关闭。 */
  reminder?: number;
}

/** 第五波并入 `AmaConfig` 的顶层段。 */
export interface AmaConfigW5 {
  images?: ImagesConfig;
  plan?: PlanConfig;
  agents?: AgentsConfig;
  subagents?: SubagentsConfig;
  models?: ModelsConfig;
  /** [W5-H2] 回退模型 `provider/model[@channel]`：可重试错误用尽或 overloaded 时切换重试一次。 */
  fallbackModel?: string;
  limits?: LimitsConfig;
  reminders?: RemindersConfig;
  todo?: TodoConfig;
}
