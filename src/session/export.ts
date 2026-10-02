/**
 * 会话导出（`ama sessions export`）：md（给人读）/ json（结构化）/ jsonl（原格式子集）。[W4-D]
 *
 * - 范围：`leaf` = 根 → 当前叶子的分支（同 `/tree` 当前位置），`all` = 文件里全部条目（文件顺序）。
 * - 三种格式都先脱敏（redact.ts）：json / jsonl 对每个字符串值做（图片 base64 保留），md 对成文做。
 * - md：用户 / 助手消息、工具调用（参数 JSON 截到 500 字符）与结果（截到 2000 字符）、压缩与分支摘要、
 *   末尾用量合计；思考块与 system 消息不写；图片写成占位 `[图片 image/png]`。
 * - jsonl：头 + 所选条目，形状与会话文件相同（可以再被 ama 读），不带 leaf 行。
 */

import type { Usage } from "../ai/types.js";
import { contentImages, contentText, numberUserMessages } from "./reuse.js";
import { redactSecrets, redactValue } from "./redact.js";
import { indexEntries, pathToRoot } from "./tree.js";
import type { SessionEntry, SessionHeader } from "./types.js";
import { msg } from "../i18n/index.js";

export type ExportFormat = "md" | "json" | "jsonl";
export type ExportBranch = "leaf" | "all";

export interface ExportInput {
  header: SessionHeader;
  entries: readonly SessionEntry[];
  leaf: string | null;
}

export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 有价请求的费用；没有有价请求时缺省。 */
  cost?: number;
}

export function selectEntries(input: ExportInput, branch: ExportBranch): SessionEntry[] {
  return branch === "all"
    ? [...input.entries]
    : pathToRoot(indexEntries(input.entries), input.leaf);
}

export function usageTotals(entries: readonly SessionEntry[]): UsageTotals {
  const totals: UsageTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  let costed = 0;
  const add = (usage: Usage | undefined): void => {
    if (usage === undefined) return;
    totals.requests++;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    if (usage.cost !== undefined) {
      cost += usage.cost.total;
      costed++;
    }
  };
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") add(entry.message.usage);
    else if (entry.type === "usage") add(entry.usage);
    else if (entry.type === "compaction" || entry.type === "branch_summary") add(entry.usage);
  }
  if (costed > 0) totals.cost = cost;
  return totals;
}

function sessionName(entries: readonly SessionEntry[]): string | undefined {
  let name: string | undefined;
  for (const entry of entries) if (entry.type === "session_info") name = entry.name;
  return name;
}

function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n${msg().session.export.truncated(text.length)}`
    : text;
}

function fence(text: string, lang = ""): string {
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function time(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "");
}

function imagesNote(content: unknown): string {
  return contentImages(content)
    .map((image) => msg().session.export.image(image.mimeType))
    .join(" ");
}

export function renderMarkdown(input: ExportInput, branch: ExportBranch): string {
  const entries = selectEntries(input, branch);
  const numbers = new Map(numberUserMessages(input.entries).map((u) => [u.entryId, u.n]));
  const name = sessionName(input.entries);
  const m = msg().session.export;
  const out: string[] = [
    `# ${name ?? m.title(input.header.id.slice(0, 8))}`,
    "",
    m.id(input.header.id),
    m.cwd(input.header.cwd),
    m.created(time(input.header.timestamp)),
    m.scope(branch === "all", entries.length),
    ...(input.header.parentSession !== undefined ? [m.parent(input.header.parentSession)] : []),
    "",
  ];
  for (const entry of entries) {
    switch (entry.type) {
      case "message": {
        const message = entry.message;
        if (message.role === "user") {
          const n = numbers.get(entry.id);
          const origin = (message as { origin?: string }).origin;
          out.push(m.user(n, origin, time(entry.timestamp)), "");
          const text = contentText(message.content);
          if (text !== "") out.push(text, "");
          const images = imagesNote(message.content);
          if (images !== "") out.push(images, "");
        } else if (message.role === "assistant") {
          out.push(m.assistant(`${message.provider}/${message.model}`, time(entry.timestamp)), "");
          for (const block of message.content) {
            if (block.type === "text" && block.text.trim() !== "") out.push(block.text, "");
            if (block.type === "toolCall") {
              out.push(
                m.toolCall(block.name),
                "",
                fence(truncate(JSON.stringify(block.arguments, null, 2), 500), "json"),
                "",
              );
            }
          }
          if (message.stopReason === "error" || message.stopReason === "aborted")
            out.push(m.stopped(message.stopReason, message.errorMessage), "");
        } else if (message.role === "toolResult") {
          out.push(
            m.toolResult(message.toolName, message.isError),
            "",
            fence(truncate(contentText(message.content), 2000)),
            "",
          );
          const images = imagesNote(message.content);
          if (images !== "") out.push(images, "");
        }
        break;
      }
      case "compaction":
        out.push(m.compaction(time(entry.timestamp)), "", entry.summary, "");
        break;
      case "branch_summary":
        out.push(m.branchSummary(time(entry.timestamp)), "", entry.summary, "");
        break;
      case "custom_message":
        if (entry.display) {
          out.push(`## ${entry.customType} · ${time(entry.timestamp)}`, "");
          out.push(contentText(entry.content), "");
        }
        break;
      case "model_change":
        out.push(
          m.modelChange(
            `${entry.provider}/${entry.modelId}${entry.channel !== undefined ? `@${entry.channel}` : ""}`,
          ),
          "",
        );
        break;
      default:
        break;
    }
  }
  const usage = usageTotals(entries);
  out.push(
    m.usage,
    "",
    m.usageHeader,
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${usage.requests} | ${usage.input} | ${usage.output} | ${usage.cacheRead} | ${usage.cacheWrite} | ${usage.cost !== undefined ? `$${usage.cost.toFixed(4)}` : "—"} |`,
    "",
  );
  return redactSecrets(out.join("\n"));
}

export function renderJson(input: ExportInput, branch: ExportBranch): string {
  const entries = selectEntries(input, branch);
  const selected = new Set(entries.map((e) => e.id));
  const name = sessionName(input.entries);
  const session: Record<string, unknown> = {
    id: input.header.id,
    cwd: input.header.cwd,
    createdAt: input.header.timestamp,
    agent: input.header.agent,
  };
  if (name !== undefined) session["name"] = name;
  if (input.header.parentSession !== undefined)
    session["parentSession"] = input.header.parentSession;
  const doc = {
    format: "ama.session-export",
    version: 1,
    session,
    branch,
    leafId: input.leaf,
    userMessages: numberUserMessages(input.entries)
      .filter((u) => selected.has(u.entryId))
      .map((u) => ({ n: u.n, entryId: u.entryId })),
    usage: usageTotals(entries),
    entries,
  };
  return JSON.stringify(redactValue(doc), null, 2) + "\n";
}

export function renderJsonl(input: ExportInput, branch: ExportBranch): string {
  const lines = [input.header, ...selectEntries(input, branch)].map((line) =>
    JSON.stringify(redactValue(line)),
  );
  return lines.join("\n") + "\n";
}

export function renderExport(
  input: ExportInput,
  format: ExportFormat,
  branch: ExportBranch,
): string {
  switch (format) {
    case "md":
      return renderMarkdown(input, branch);
    case "json":
      return renderJson(input, branch);
    case "jsonl":
      return renderJsonl(input, branch);
  }
}
