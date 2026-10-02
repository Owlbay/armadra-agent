/**
 * 轨迹节点的正文预览（脱敏版）：HTML 导出与 RPC `get_trace{content:"preview"}` 共用。[W6-T2]
 *
 * 与 `detail.ts` 的 `nodePreviews`（只给本机 TUI 用、未脱敏）同一截断口径：参数 JSON 500 字符、提示 / 输出 /
 * 结果 2000 字符。顺序很重要：**先脱敏整段原文，再截断**——反过来截断会把密钥截成不再匹配形态的残片。
 * 参数先 `redactValue`（键名像机密的值整段遮掉）再序列化，序列化后再过一遍 `redactSecrets`。
 */

import { contentText } from "../session/reuse.js";
import { redactSecrets, redactValue } from "../session/redact.js";
import { ARGS_PREVIEW_MAX, RESULT_PREVIEW_MAX, type TraceEntryLookup } from "./detail.js";
import type { TraceNode } from "./flatten.js";

/** 一个节点的预览；每段都已脱敏与截断（被截断的以 `…` 结尾）。 */
export interface TracePreview {
  /** 回合：用户提示。 */
  input?: string;
  /** 请求：助手文字。 */
  output?: string;
  /** 工具：参数 JSON。 */
  args?: string;
  /** 工具：结果文本。 */
  result?: string;
}

function clip(text: string, max: number): string {
  const clean = redactSecrets(text);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function messageOf(lookup: TraceEntryLookup, id: string | undefined) {
  const entry = id === undefined ? undefined : lookup.entry(id);
  return entry?.type === "message" ? entry.message : undefined;
}

/** 节点 → 预览；没有正文返回 undefined。 */
export function previewOf(node: TraceNode, lookup: TraceEntryLookup): TracePreview | undefined {
  const out: TracePreview = {};
  if (node.kind === "turn") {
    const m = messageOf(lookup, node.id);
    if (m?.role === "user") out.input = clip(contentText(m.content), RESULT_PREVIEW_MAX);
  } else if (node.kind === "step") {
    const m = messageOf(lookup, node.id);
    if (m?.role === "assistant") {
      const text = m.content
        .flatMap((b) => (b.type === "text" && b.text.trim() !== "" ? [b.text] : []))
        .join("\n");
      if (text !== "") out.output = clip(text, RESULT_PREVIEW_MAX);
    }
  } else if (node.kind === "tool") {
    const m = messageOf(lookup, node.entryIds[0]);
    if (m?.role === "assistant")
      for (const block of m.content)
        if (block.type === "toolCall" && block.id === node.id)
          out.args = clip(JSON.stringify(redactValue(block.arguments), null, 2), ARGS_PREVIEW_MAX);
    const r = messageOf(lookup, node.entryIds[1]);
    if (r?.role === "toolResult") out.result = clip(contentText(r.content), RESULT_PREVIEW_MAX);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 预览的字符数（总预算用）。 */
export function previewSize(p: TracePreview): number {
  return (
    (p.input?.length ?? 0) +
    (p.output?.length ?? 0) +
    (p.args?.length ?? 0) +
    (p.result?.length ?? 0)
  );
}

/** 预览表的 key：`<kind>:<id>`（同一轨迹内唯一；子轨迹的节点 id 来自子会话条目）。 */
export function previewKey(node: { kind: string; id: string }): string {
  return `${node.kind}:${node.id}`;
}
