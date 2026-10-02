/**
 * 档一裁剪（设计 §9「档一」，wave5 §8.2 C1 / C2 / C4 / C10）：无模型调用。[B2][W5-H1]
 *
 * 边界按**工具结果新旧**计（C1，修 G1：只有一条 user 消息的长任务以前永不触发）：从最新往回数，
 * 最近 `keepResults` 个结果与累计不超过 `protectTokens` 的结果不动；更早、估算 > 512 token、
 * 不在保护集里的结果是候选。
 * 门槛与回差（C2）：候选合计可省 < `clearAtLeast` 不动；动就一次清到目标（调用方给 `need` =
 * 当前 − 0.5×预算，且至少 `clearAtLeast`），从最旧的开始换，避免过线后每回合推进一点、每回合
 * 打断一次缓存。缓存已冷时（C3，调用方判断）`need` 为 undefined：全部候选一次换掉。
 * 保护集（C4）：调用方给 `isProtected`（Skill 文件、AGENTS.md、todo、`keepInContext` 工具、
 * `compaction.pruneExclude`），见 `protect.ts`。
 * 动作：返回 `context_edit{reason:"prune", replacement:"[pruned: … full text at path]"}` 计划（[W6-C0] 固定英文）；有 outputDir 时
 * 把全文写到 `<outputDir>/<toolCallId>.txt`（已存在则不覆盖），模型可用 read 取回。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock } from "../ai/types.js";
import type { PruneConfig } from "../config/types.js";
import type { ContextItem } from "../session/projection.js";
import { estimateContentTokens } from "./estimate.js";

export const PRUNE_TRIGGER_RATIO = 0.7;
export const PRUNE_TARGET_RATIO = 0.5;
export const PRUNE_KEEP_RESULTS = 5;
/** 保护最近 min(40k, 0.2×预算) token 的工具输出。 */
export const PRUNE_PROTECT_TOKENS = 40_000;
export const PRUNE_PROTECT_RATIO = 0.2;
/**
 * `clearAtLeast: "auto"` = max(20k, 0.1×预算)，但不超过 0.2×预算（= 触发线与目标之差；小窗口
 * 模型上 20k 比这段差还大，档一就永远不会动）。
 */
export const PRUNE_CLEAR_AT_LEAST = 20_000;
export const PRUNE_CLEAR_AT_LEAST_RATIO = 0.1;
export const PRUNE_CLEAR_AT_LEAST_CAP_RATIO = 0.2;
/** 小于等于此估算 token 的结果不裁（占位本身也要几十 token）。 */
export const PRUNE_MIN_TOKENS = 512;
/** 占位文本的估算（含全文路径）。 */
const REPLACEMENT_TOKENS = 48;

/** 由预算（窗口 − 预留）与配置得出的档一参数；只有 keepResults / clearAtLeast 进配置面（D27）。 */
export interface PrunePolicy {
  keepResults: number;
  protectTokens: number;
  clearAtLeast: number;
  minTokens: number;
  /** 超过才按阈值裁（0.7×预算）。 */
  triggerTokens: number;
  /** 一次清到（0.5×预算）。 */
  targetTokens: number;
}

export function prunePolicy(budget: number, config: PruneConfig = {}): PrunePolicy {
  const clear = config.clearAtLeast;
  return {
    keepResults: Math.max(0, Math.floor(config.keepResults ?? PRUNE_KEEP_RESULTS)),
    protectTokens: Math.floor(Math.min(PRUNE_PROTECT_TOKENS, PRUNE_PROTECT_RATIO * budget)),
    clearAtLeast:
      typeof clear === "number"
        ? Math.max(0, clear)
        : Math.floor(
            Math.min(
              Math.max(PRUNE_CLEAR_AT_LEAST, PRUNE_CLEAR_AT_LEAST_RATIO * budget),
              PRUNE_CLEAR_AT_LEAST_CAP_RATIO * budget,
            ),
          ),
    minTokens: PRUNE_MIN_TOKENS,
    triggerTokens: PRUNE_TRIGGER_RATIO * budget,
    targetTokens: PRUNE_TARGET_RATIO * budget,
  };
}

export interface PrunePlanItem {
  targetId: string;
  replacement: string;
  toolCallId: string;
  originalBytes: number;
  /** 估算可省的 token。 */
  savedTokens: number;
  fullTextPath?: string;
}

export interface PrunePlan {
  items: PrunePlanItem[];
  /** 本计划省下的 token（估算）。 */
  savedTokens: number;
  /** 全部候选合计可省（不足 clearAtLeast 时计划为空）。 */
  availableTokens: number;
}

/** 保护集判断的输入：结果所属工具与调用参数（从同一投影里的助手消息找）。 */
export interface PruneCandidate {
  toolName: string;
  args: Record<string, unknown> | undefined;
}

export interface PruneOptions {
  policy: Pick<PrunePolicy, "keepResults" | "protectTokens" | "clearAtLeast" | "minTokens">;
  /** 至少要省多少才到目标；undefined = 全部候选（缓存已冷）。实际至少 clearAtLeast。 */
  need?: number | undefined;
  /** 全文落盘目录；undefined 时不落盘（内存会话）。 */
  outputDir?: string | undefined;
  /** 保护集（C4）：返回 true 的结果不裁。 */
  isProtected?(candidate: PruneCandidate): boolean;
}

export function contentToText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
    .join("\n");
}

function safeFileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "tool";
}

function toolCallArgs(items: readonly ContextItem[]): Map<string, Record<string, unknown>> {
  const args = new Map<string, Record<string, unknown>>();
  for (const { message } of items) {
    if (message.role !== "assistant") continue;
    for (const block of message.content)
      if (block.type === "toolCall") args.set(block.id, block.arguments);
  }
  return args;
}

interface Candidate {
  item: ContextItem;
  tokens: number;
}

/** 候选：按新旧排除最近 keepResults 个与 protectTokens 内的结果、保护集与小结果；按时间正序。 */
function collectCandidates(items: readonly ContextItem[], options: PruneOptions): Candidate[] {
  const { keepResults, protectTokens, minTokens } = options.policy;
  const args = toolCallArgs(items);
  const out: Candidate[] = [];
  let seen = 0;
  let recentTokens = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined) continue;
    const { message, entry } = item;
    if (message.role !== "toolResult") continue;
    const tokens = estimateContentTokens(message.content);
    seen++;
    recentTokens += tokens;
    if (seen <= keepResults || recentTokens <= protectTokens) continue;
    if (entry.type !== "message" || tokens <= minTokens) continue;
    const candidate = { toolName: message.toolName, args: args.get(message.toolCallId) };
    if (options.isProtected?.(candidate) === true) continue;
    out.push({ item, tokens });
  }
  return out.reverse();
}

function materialize(candidate: Candidate, outputDir: string | undefined): PrunePlanItem {
  const { message, entry } = candidate.item;
  if (message.role !== "toolResult") throw new Error("not a tool result");
  const text = contentToText(message.content);
  const bytes = Buffer.byteLength(text, "utf8");
  let fullTextPath: string | undefined;
  if (outputDir !== undefined) {
    fullTextPath = join(outputDir, `${safeFileStem(message.toolCallId)}.txt`);
    try {
      if (!existsSync(fullTextPath)) {
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(fullTextPath, text, "utf8");
      }
    } catch {
      fullTextPath = undefined;
    }
  }
  const replacement =
    fullTextPath === undefined
      ? `[pruned: ${message.toolName} result was ${bytes} bytes; full text unavailable]`
      : `[pruned: ${message.toolName} result was ${bytes} bytes; full text at ${fullTextPath}]`;
  const planned: PrunePlanItem = {
    targetId: entry.id,
    replacement,
    toolCallId: message.toolCallId,
    originalBytes: bytes,
    savedTokens: Math.max(0, candidate.tokens - REPLACEMENT_TOKENS),
  };
  if (fullTextPath !== undefined) planned.fullTextPath = fullTextPath;
  return planned;
}

/** 计算裁剪计划（并为选中项落盘全文）；`items` 为空表示不裁。 */
export function planPrune(items: readonly ContextItem[], options: PruneOptions): PrunePlan {
  const candidates = collectCandidates(items, options);
  const saving = (c: Candidate): number => Math.max(0, c.tokens - REPLACEMENT_TOKENS);
  const availableTokens = candidates.reduce((sum, c) => sum + saving(c), 0);
  const { clearAtLeast } = options.policy;
  if (candidates.length === 0 || availableTokens < clearAtLeast || availableTokens <= 0)
    return { items: [], savedTokens: 0, availableTokens };
  const need =
    options.need === undefined ? Number.POSITIVE_INFINITY : Math.max(options.need, clearAtLeast);
  const plan: PrunePlanItem[] = [];
  let savedTokens = 0;
  for (const candidate of candidates) {
    if (savedTokens >= need) break;
    const planned = materialize(candidate, options.outputDir);
    plan.push(planned);
    savedTokens += planned.savedTokens;
  }
  return { items: plan, savedTokens, availableTokens };
}
