/**
 * `max_tokens` 的主动收紧与被动修正（docs/model-efficiency-plan.md §1.9、D9）。[ME-C]
 *
 * - 主动收紧：窗口已知时 `max_tokens = min(请求值, max(MIN_OUTPUT_TOKENS, 窗口 − 估算输入 − 余量))`，
 *   输入按请求体字符 / 4 估算（本模块自带，不依赖 compaction/）。预算型思考（`fixed`）不收紧：
 *   预算由 max_tokens 推导，改它会让消息缓存失效。
 * - 被动修正：端点以 400 拒收并说出上限（「max_tokens 范围」类文案）时，记入进程级 `maxTokensCaps`、
 *   以上限重发一次；之后同一模型的请求直接用上限。Anthropic「输入 + max_tokens 超出上下文」只按这次
 *   的输入算出可用值重发、不记上限；可用值不足 `MIN_OUTPUT_TOKENS` 判为溢出（overflow.ts 认得该文案）。
 *   重发只发生在 `start` 之前，流契约不变（与 `postWithCacheFallback` 同模式，包在它外层）。
 * - 跨进程：学到的上限经 `onMaxTokensCap` 写进 `<dataDir>/models/max-tokens-caps.json`（30 天），
 *   组装注册表时载回（providers/max-tokens-cache.ts，#152）。
 */

import { HttpError, errorText, type PostOptions } from "../http.js";
import type { Model } from "../types.js";
import { postWithCacheFallback } from "./cache-params.js";

/** 主动收紧的下限：再小就不如让请求原样发出、由被动修正或溢出处理接手。 */
export const MIN_OUTPUT_TOKENS = 1024;
/** 窗口里给估算误差留的余量。 */
export const OUTPUT_HEADROOM_TOKENS = 2048;

/** 请求体里放 max_tokens 的字段名（三条协议各不相同）。 */
export type MaxTokensField = "max_tokens" | "max_completion_tokens" | "max_output_tokens";

/** `${provider}/${model}` → 已知上限（被动修正时记入，之后的请求直接用）。 */
export const maxTokensCaps = new Map<string, number>();

const capListeners = new Set<(key: string, cap: number) => void>();

/** 被动修正学到新上限时通知（数据目录持久化用，max-tokens-cache.ts）；返回取消函数。 */
export function onMaxTokensCap(listener: (key: string, cap: number) => void): () => void {
  capListeners.add(listener);
  return () => capListeners.delete(listener);
}

type Json = Record<string, unknown>;

/** 主动收紧后的 max_tokens；`window` 未知或 `fixed`（预算型思考）时返回 requested。 */
export function clampMaxTokens(
  requested: number,
  window: number | undefined,
  estimatedInput: number,
  fixed: boolean,
): number {
  if (fixed || window === undefined || !Number.isFinite(window) || window <= 0) return requested;
  const room = Math.floor(window - estimatedInput - OUTPUT_HEADROOM_TOKENS);
  return Math.min(requested, Math.max(MIN_OUTPUT_TOKENS, room));
}

/** 请求体的输入 token 估算：JSON 字符数 / 4（CJK 偏低，由被动修正兜底）。 */
export function estimateInputTokens(body: unknown): number {
  try {
    return Math.ceil(JSON.stringify(body).length / 4);
  } catch {
    return 0;
  }
}

/**
 * 就地收紧 `holder[field]`（缺省 holder = body；Google 的 `generationConfig.maxOutputTokens`
 * 传 holder）。字段不是数字时不动。
 */
export function clampRequestMaxTokens(
  body: Json,
  field: string,
  window: number | undefined,
  fixed = false,
  holder: Json = body,
): void {
  const requested = holder[field];
  if (typeof requested !== "number" || fixed || window === undefined) return;
  holder[field] = clampMaxTokens(requested, window, estimateInputTokens(body), false);
}

/** Google `generationConfig.maxOutputTokens`；带正的思考预算时不收紧（预算按回答上限留白算出）。 */
export function clampGoogleMaxTokens(body: Json, window: number | undefined): void {
  const config = body["generationConfig"];
  if (typeof config !== "object" || config === null) return;
  const thinking = (config as Json)["thinkingConfig"];
  const budget =
    typeof thinking === "object" && thinking !== null
      ? (thinking as Json)["thinkingBudget"]
      : undefined;
  const fixed = typeof budget === "number" && budget > 0;
  clampRequestMaxTokens(body, "maxOutputTokens", window, fixed, config as Json);
}

/** 内部解析结果：`transient` = 只对这次请求的输入成立，不记为模型上限。 */
type Rejection = { cap: number; transient: boolean } | { overflow: true };

const NUM = "`?(\\d[\\d,_]*)`?";
const toInt = (text: string | undefined): number => Number((text ?? "").replace(/[,_]/g, ""));

const RANGE = new RegExp(
  `range of \`?max_\\w*tokens\`?\\s*(?:should be|is|must be)?\\s*[[(]\\s*\\d+\\s*,\\s*${NUM}\\s*[\\])]`,
  "i",
);
const LIMIT = new RegExp(
  `max_\\w*tokens\`?[^\\n]{0,200}?(?:must be|should be|less than or equal to|at most|<=)\\s*${NUM}`,
  "i",
);
const CONTEXT_LIMIT =
  /input length and `?max_tokens`? exceed context limit:?\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/i;

function classify(error: unknown): Rejection | undefined {
  if (error instanceof HttpError && error.status !== 400 && error.status !== 422) return undefined;
  const text = errorText(error);
  const context = CONTEXT_LIMIT.exec(text);
  if (context) {
    const cap = toInt(context[3]) - toInt(context[1]);
    return cap < MIN_OUTPUT_TOKENS ? { overflow: true } : { cap, transient: true };
  }
  const match = RANGE.exec(text) ?? LIMIT.exec(text);
  if (!match) return undefined;
  const cap = toInt(match[1]);
  return Number.isFinite(cap) && cap >= 1 ? { cap, transient: false } : undefined;
}

/** 400 文案里的上限；`{ cap }` 可重发，`{ overflow: true }` 判溢出，undefined 不是本类错误。 */
export function parseMaxTokensRejection(
  error: unknown,
): { cap: number } | { overflow: true } | undefined {
  const rejection = classify(error);
  return rejection === undefined || "overflow" in rejection ? rejection : { cap: rejection.cap };
}

/** body[field] 超过 cap 时返回改小后的浅拷贝，否则原样返回。 */
function withCap(body: unknown, field: MaxTokensField, cap: number | undefined): unknown {
  if (cap === undefined || typeof body !== "object" || body === null) return body;
  const value = (body as Json)[field];
  return typeof value === "number" && value > cap ? { ...(body as Json), [field]: cap } : body;
}

/** Anthropic 预算型思考：budget_tokens 必须小于 max_tokens，上限压不下时不重发。 */
function budgetFits(body: unknown, cap: number): boolean {
  const thinking = (body as Json)["thinking"];
  if (typeof thinking !== "object" || thinking === null) return true;
  const budget = (thinking as Json)["budget_tokens"];
  return typeof budget !== "number" || budget < cap;
}

/** `postWithCacheFallback` 之外再包一层：max_tokens 超上限的 400 以收紧值重发一次（只在 `start` 之前）。 */
export async function postWithMaxTokensFallback(
  model: Pick<Model, "provider" | "id">,
  url: string,
  options: PostOptions,
  field: MaxTokensField,
): Promise<Response> {
  const key = `${model.provider}/${model.id}`;
  const body = withCap(options.body, field, maxTokensCaps.get(key));
  try {
    return await postWithCacheFallback(model, url, { ...options, body });
  } catch (error) {
    if (options.signal.aborted || typeof body !== "object" || body === null) throw error;
    const rejection = classify(error);
    const sent = (body as Json)[field];
    if (rejection === undefined || !("cap" in rejection) || typeof sent !== "number") throw error;
    if (rejection.cap >= sent || !budgetFits(body, rejection.cap)) throw error;
    if (!rejection.transient) {
      maxTokensCaps.set(key, rejection.cap);
      for (const listener of capListeners) listener(key, rejection.cap);
    }
    return postWithCacheFallback(model, url, {
      ...options,
      body: withCap(body, field, rejection.cap),
    });
  }
}
