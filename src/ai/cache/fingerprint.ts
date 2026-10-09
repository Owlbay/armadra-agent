/**
 * 前缀指纹（第三波 §1.2）：一次请求的「可缓存前缀」= 折叠后的系统提示 + 工具表 + 模型。[W3-C1b]
 *
 * - `system` = sha256(normalizeContext().systemPrompt) 前 64 bit；
 * - `tools` = sha256(JSON.stringify(工具表按名排序)) 前 64 bit；
 * - `model` = `${provider}/${id}` 原文；
 * - `sections` = 折叠后每个非空节的 hash16（[ME-B] D15：归因时说出哪一节变了）。
 * 纯函数、零请求；每次真实请求算一次（system + tools 通常 < 20 KB）。未命中归因时与上一条
 * 记录比对，说出「变了什么」。
 */

import { createHash } from "node:crypto";
import { normalizeContext } from "../context.js";
import type { Model, ModelRef, ToolDecl, TranscriptContext } from "../types.js";
import type { PrefixFingerprint } from "./types.js";

/** sha256 的前 16 位 hex（64 bit）。 */
export function hash16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function modelKey(model: Pick<Model, "provider" | "id" | "channel"> | ModelRef): string {
  return `${model.provider}/${model.id}${model.channel !== undefined ? `@${model.channel}` : ""}`;
}

function sortedTools(tools: readonly ToolDecl[]): ToolDecl[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function fingerprintContext(
  context: TranscriptContext,
  model: Pick<Model, "provider" | "id">,
): PrefixFingerprint {
  const normalized = normalizeContext(context);
  const sections: Record<string, string> = {};
  for (const section of normalized.systemSections) sections[section.name] = hash16(section.text);
  return {
    system: hash16(normalized.systemPrompt),
    tools: hash16(JSON.stringify(sortedTools(normalized.tools))),
    model: modelKey(model),
    sections,
  };
}

/** 变化的节名：先按 `cur` 的节顺序列新增 / 改动的，再列 `prev` 里消失的；任一方没有按节指纹 → []。 */
export function changedSections(prev: PrefixFingerprint, cur: PrefixFingerprint): string[] {
  if (prev.sections === undefined || cur.sections === undefined) return [];
  const before = prev.sections;
  const after = cur.sections;
  const changed = Object.keys(after).filter((name) => before[name] !== after[name]);
  for (const name of Object.keys(before)) if (!(name in after)) changed.push(name);
  return changed;
}

/** 两个指纹的差异（按归因顺序：system → tools → model）；相同返回 undefined。 */
export function fingerprintChange(
  prev: PrefixFingerprint,
  cur: PrefixFingerprint,
): "system" | "tools" | "model" | undefined {
  if (prev.system !== cur.system) return "system";
  if (prev.tools !== cur.tools) return "tools";
  if (prev.model !== cur.model) return "model";
  return undefined;
}
