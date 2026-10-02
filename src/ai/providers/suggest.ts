/**
 * 模型 / 供应商 / 渠道写错时的候选与报错文案（W4-C）。
 *
 * 候选排序：包含关系（`sonnet` ⊂ `claude-sonnet-5`）优先，其次按编辑距离；距离超过
 * `max(2, ⌈长度 / 3⌉)` 的不算接近。只比较 id 本身（不含 `provider/` 前缀），大小写不敏感。
 */

import type { ModelLookup } from "../types.js";
import { msg } from "../../i18n/index.js";

/** Levenshtein 距离（插入 / 删除 / 替换各计 1）。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * 从 `candidates` 里挑与 `needle` 最接近的至多 `limit` 个。`key` 取参与比较的部分
 * （缺省整串），返回原值。
 */
export function closest<T>(
  needle: string,
  candidates: readonly T[],
  limit = 5,
  key: (item: T) => string = String,
): T[] {
  const target = needle.toLowerCase();
  if (target === "") return [];
  const budget = Math.max(2, Math.ceil(target.length / 3));
  const scored: { item: T; score: number; index: number }[] = [];
  candidates.forEach((item, index) => {
    const value = key(item).toLowerCase();
    if (value === "") return;
    if (value.includes(target) || target.includes(value)) {
      scored.push({ item, score: Math.abs(value.length - target.length) / 1000, index });
      return;
    }
    const distance = editDistance(target, value);
    if (distance <= budget) scored.push({ item, score: distance, index });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** 解析失败的一行说明（不含前缀标签）：`渠道不存在：x；该模型可用渠道：…` 等。 */
export function describeLookupFailure(
  ref: string,
  failure: Extract<ModelLookup, { ok: false }>,
): string {
  const list = failure.candidates.slice(0, 20).join(", ");
  return msg().errors.models.lookupFailure(
    ref,
    failure.reason,
    list,
    failure.candidates.length > 0,
  );
}
