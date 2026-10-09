/**
 * `max_tokens` 的主动收紧与被动修正（docs/model-efficiency-plan.md §1.9、D9）。
 *
 * [ME-C0] 空壳：只导出签名，实现归 ME-C——`clampMaxTokens` 直接返回请求值、`parseMaxTokensRejection`
 * 一律返回 undefined、`postWithMaxTokensFallback` 只是 `postWithCacheFallback`，行为与现状相同。
 */

import type { PostOptions } from "../http.js";
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

/** 主动收紧后的 max_tokens；`window` 未知或 `fixed`（预算型思考）时返回 requested。 */
export function clampMaxTokens(
  requested: number,
  _window: number | undefined,
  _estimatedInput: number,
  _fixed: boolean,
): number {
  return requested;
}

/** 400 文案里的上限；`{ cap }` 可重发，`{ overflow: true }` 判溢出，undefined 不是本类错误。 */
export function parseMaxTokensRejection(
  _error: unknown,
): { cap: number } | { overflow: true } | undefined {
  return undefined;
}

/** `postWithCacheFallback` 之外再包一层：max_tokens 超上限的 400 以收紧值重发一次（只在 `start` 之前）。 */
export async function postWithMaxTokensFallback(
  model: Pick<Model, "provider" | "id">,
  url: string,
  options: PostOptions,
  _field: MaxTokensField,
): Promise<Response> {
  return postWithCacheFallback(model, url, options);
}
