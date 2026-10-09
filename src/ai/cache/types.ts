/**
 * 会话层缓存的共享类型（第三波 §1.2、§1.5–§1.7）。[W3-C0] 契约文件，实现归 W3-C1b。
 *
 * 补全与偏差（相对第三波设计正文）：
 * - 设计把本文件列在 C1b；为让 C2（展示）、宿主（`cache.onWarmingDecision`）与配置
 *   （`cache.warming`）在 C1b 合入前就能引用同一组名字，类型在契约 PR 里先定死，C1b 只追加。
 * - `CacheMiss.missedCost` 写成可选：§1.5 第 4 步「模型无价格 → undefined」，正文接口写的是
 *   `number`，以算法为准。
 * - 补全 `CacheMissReason`、`WarmingPhase`、`WarmerState`、`WarmerStatus` 与 `WarmDecision`
 *   的字段（正文只给了 `decide({ warmCost, missCost, probability, action })`）。
 */

import type {
  Api,
  ModelRef,
  RequestPurpose,
  StreamOptions,
  TranscriptContext,
  Usage,
} from "../types.js";

/** 前缀指纹：各 16 位 hex（sha256 前 64 bit）。 */
export interface PrefixFingerprint {
  /** `normalizeContext().systemPrompt` 的哈希。 */
  system: string;
  /** 工具表按名排序后 `JSON.stringify` 的哈希。 */
  tools: string;
  /** `${provider}/${id}`（原文，不哈希）。 */
  model: string;
  /** 节名 → hash16，归因时说出哪一节变了。 */
  sections?: Record<string, string>;
}

/** 每次真实请求在会话层记一条（内存，不落盘）。 */
export interface RequestRecord {
  /** 请求发出时刻（保温计时从这里算，不是响应结束）。 */
  at: number;
  purpose: RequestPurpose;
  model: ModelRef;
  api: Api;
  baseUrl: string;
  fingerprint: PrefixFingerprint;
  /** input + cacheRead + cacheWrite。 */
  promptTokens: number;
  /** 含 cost 与 cacheReported。 */
  usage: Usage;
  /** 保温重放用（同一引用）。 */
  contextRef: TranscriptContext;
  options: Omit<StreamOptions, "signal">;
}

/** 「供应商不报缓存」三态（§1.6）；按 `(provider, baseUrl 主机名, model)` 维护。 */
export type CacheReporting = "unknown" | "reported" | "silent";

/** 未命中原因（§1.5 第 6 步的归因顺序）。 */
export type CacheMissReason = "prefix_changed" | "model_changed" | "idle" | "subtask" | "evicted";

export const CACHE_MISS_REASONS: readonly CacheMissReason[] = [
  "prefix_changed",
  "model_changed",
  "idle",
  "subtask",
  "evicted",
];

export interface CacheMiss {
  /** 重计费 token。 */
  missedTokens: number;
  /** 重计费金额（美元）；模型无价格时缺省（显示 `$?`）。 */
  missedCost?: number;
  reason: CacheMissReason;
  /** `prefix_changed` 时哪一段变了。 */
  detail?: "system" | "tools";
  /** 与上一条可比请求的间隔。 */
  idleMs: number;
}

/** 保温模式（§1.7）：off 不保温；streaming 只在工具运行期间；idle 另含空闲相（需 opt-in）。 */
export type WarmingMode = "off" | "streaming" | "idle";

export const WARMING_MODES: readonly WarmingMode[] = ["off", "streaming", "idle"];

/** 保温所处的相：agent 运行中（streaming）或已 settle（idle）。 */
export type WarmingPhase = "streaming" | "idle";

/** 一次保温前的决策（`economics.evaluateWarm` 产出，宿主否决钩子的入参）。 */
export interface WarmDecision {
  /** 内置决策。 */
  action: "warm" | "stop";
  phase: WarmingPhase;
  /** 上一次真实请求的 input + cacheRead + cacheWrite。 */
  promptTokens: number;
  /** 一次保温请求的花费（美元）；价格缺失时 undefined（经济性不可算 → stop）。 */
  warmCost: number | undefined;
  /** 不保温而失效时多付的金额（美元）。 */
  missCost: number | undefined;
  /** 失效后仍会再发请求的概率：streaming 1、idle 0.15。 */
  probability: number;
  /** stop 的原因（如 `no_price`、`below_min_savings`），warm 时缺省。 */
  reason?: string;
}

/** 宿主 / 扩展的否决钩子（HostApi `cache.onWarmingDecision`）；出错回落内置决策。 */
export type WarmingDecisionHandler = (
  decision: WarmDecision,
) => "warm" | "stop" | Promise<"warm" | "stop">;

/** inactive：还没有可重放的真实请求或已 cancel；scheduled：计时器在等；stopped：因故停止。 */
export type WarmerState = "inactive" | "scheduled" | "stopped";

export interface WarmerStatus {
  mode: WarmingMode;
  state: WarmerState;
  phase?: WarmingPhase;
  /** 下一次保温的时刻（epoch ms），state 为 scheduled 时给。 */
  nextWarmAt?: number;
  /** stopped 的原因。 */
  reason?: string;
  /** 本会话已发出的保温请求数。 */
  sent?: number;
  /** 保温累计花费（美元）。 */
  costUsd?: number;
  /** 最近一次决策的期望节省（美元）。 */
  expectedSavingsUsd?: number;
}
