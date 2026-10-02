/**
 * 跨会话全文检索（`ama sessions search`）。[W4-D]
 *
 * - 模式：普通关键词（不区分大小写的子串）或 `/正则/标志`；
 * - 检索的文本：user = 文本块；assistant = 文本块 + 工具调用（`名字 参数 JSON`）；tool = 工具结果文本。
 *   思考块、system、custom 不检索；
 * - 关键词不含 `"`、`\` 与控制字符时，先在原始行上做子串预筛（JSON 只转义这些字符，中文原样），
 *   不命中的行不解析；正则没法预筛，逐行解析消息行；
 * - 每条命中带：会话 id、条目时间、项目（头的 cwd）、角色、条目序号（文件里第几条条目，1 起）、
 *   user 的消息编号（同 `sessions show` / `--from`）、片段与命中区间（展示层负责高亮）。
 * - 文件按创建时间倒序（最新在前），文件内按条目顺序；到 limit 停。
 */

import { lineType, forEachLine } from "./scan.js";
import { contentText } from "./reuse.js";

export type SearchRole = "user" | "assistant" | "tool";

export interface SearchHit {
  sessionId: string;
  file: string;
  cwd: string;
  timestamp: string;
  role: SearchRole;
  /** 文件里第几条条目（1 起，不含头与 leaf 行）。 */
  entryIndex: number;
  entryId: string;
  /** user 的消息编号。 */
  userN?: number;
  snippet: string;
  /** snippet 里的命中区间 `[start, end)`。 */
  ranges: Array<[number, number]>;
}

export interface SearchQuery {
  /** 返回 `[start, end)` 区间；没有命中返回空数组。 */
  match(text: string): Array<[number, number]>;
  /** 原始行一定不含时返回 false（可跳过解析）；不确定返回 true。 */
  mayContain(line: string): boolean;
}

/** `/re/flags` → 正则；其它 → 不区分大小写的子串。非法正则抛 SyntaxError。 */
export function compileQuery(pattern: string): SearchQuery {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (regex !== null) {
    const flags = new Set((regex[2] ?? "").split(""));
    flags.add("g");
    const re = new RegExp(regex[1] ?? "", [...flags].join(""));
    return {
      match(text) {
        const out: Array<[number, number]> = [];
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          if (m[0] === "") continue;
          out.push([m.index, m.index + m[0].length]);
          if (out.length >= 20) break;
        }
        return out;
      },
      mayContain: () => true,
    };
  }
  const needle = pattern.toLowerCase();
  // eslint-disable-next-line no-control-regex
  const prefilter = !/["\\\u0000-\u001f]/.test(pattern);
  return {
    match(text) {
      const out: Array<[number, number]> = [];
      const hay = text.toLowerCase();
      let at = hay.indexOf(needle);
      while (at >= 0 && out.length < 20) {
        out.push([at, at + needle.length]);
        at = hay.indexOf(needle, at + needle.length);
      }
      return out;
    },
    mayContain: (line) => !prefilter || line.toLowerCase().includes(needle),
  };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function searchableText(message: Rec): { role: SearchRole; text: string } | undefined {
  switch (message["role"]) {
    case "user":
      return { role: "user", text: contentText(message["content"]) };
    case "toolResult":
      return { role: "tool", text: contentText(message["content"]) };
    case "assistant": {
      const parts: string[] = [];
      const content = message["content"];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRec(block)) continue;
          if (block["type"] === "text" && typeof block["text"] === "string")
            parts.push(block["text"]);
          if (block["type"] === "toolCall")
            parts.push(`${String(block["name"])} ${JSON.stringify(block["arguments"] ?? {})}`);
        }
      }
      return { role: "assistant", text: parts.join("\n") };
    }
    default:
      return undefined;
  }
}

/** 命中附近的单行片段（空白压平），区间换算到片段坐标。 */
export function makeSnippet(
  text: string,
  ranges: ReadonlyArray<[number, number]>,
  context = 50,
): { snippet: string; ranges: Array<[number, number]> } {
  const [first] = ranges;
  if (first === undefined) return { snippet: "", ranges: [] };
  const start = Math.max(0, first[0] - context);
  const end = Math.min(text.length, first[1] + context);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  // 压平空白时逐字符换算，区间跟着移动。
  let out = prefix;
  const map: number[] = [];
  let lastSpace = false;
  for (let i = start; i < end; i++) {
    const ch = text[i] ?? "";
    map[i - start] = out.length;
    if (/\s/.test(ch)) {
      if (!lastSpace) out += " ";
      lastSpace = true;
    } else {
      out += ch;
      lastSpace = false;
    }
  }
  map[end - start] = out.length;
  const mapped: Array<[number, number]> = [];
  for (const [a, b] of ranges) {
    if (a < start || b > end) continue;
    mapped.push([map[a - start] ?? 0, map[b - start] ?? out.length]);
  }
  return { snippet: out + suffix, ranges: mapped };
}

export interface SearchOptions {
  roles?: ReadonlySet<SearchRole>;
  /** ISO 时间下限（含）；比较条目 timestamp。 */
  sinceIso?: string;
  limit: number;
}

/** 在一批文件里检索；返回命中（最多 limit 条）与是否到了上限（可能还有更多）。 */
export function searchSessions(
  files: readonly string[],
  query: SearchQuery,
  options: SearchOptions,
): { hits: SearchHit[]; truncated: boolean } {
  const hits: SearchHit[] = [];
  let truncated = false;
  for (const file of files) {
    if (hits.length >= options.limit) break;
    let header: { id: string; cwd: string } | undefined;
    let entryIndex = 0;
    let userN = 0;
    try {
      forEachLine(file, (line, index) => {
        if (index === 0) {
          try {
            const h = JSON.parse(line) as Rec;
            if (h["type"] !== "session") return false;
            header = { id: String(h["id"]), cwd: String(h["cwd"]) };
          } catch {
            return false;
          }
          return;
        }
        const quick = lineType(line);
        if (quick?.type === "leaf") return;
        entryIndex++;
        if (quick !== undefined && quick.type !== "message") return;
        const isUser = quick?.role === "user";
        if (isUser) userN++;
        if (quick?.role === "system") return;
        if (!query.mayContain(line)) return;
        let entry: Rec;
        try {
          entry = JSON.parse(line) as Rec;
        } catch {
          return;
        }
        if (quick === undefined) {
          // 非 ama 形状的行：解析后再判断
          if (entry["type"] === "leaf") {
            entryIndex--;
            return;
          }
          if (entry["type"] !== "message") return;
          if (isRec(entry["message"]) && entry["message"]["role"] === "user") userN++;
        }
        const message = entry["message"];
        if (!isRec(message) || header === undefined) return;
        const found = searchableText(message);
        if (found === undefined) return;
        if (options.roles !== undefined && !options.roles.has(found.role)) return;
        const timestamp = typeof entry["timestamp"] === "string" ? entry["timestamp"] : "";
        if (options.sinceIso !== undefined && timestamp < options.sinceIso) return;
        const ranges = query.match(found.text);
        if (ranges.length === 0) return;
        const snippet = makeSnippet(found.text, ranges);
        const hit: SearchHit = {
          sessionId: header.id,
          file,
          cwd: header.cwd,
          timestamp,
          role: found.role,
          entryIndex,
          entryId: String(entry["id"]),
          snippet: snippet.snippet,
          ranges: snippet.ranges,
        };
        if (found.role === "user") hit.userN = userN;
        hits.push(hit);
        if (hits.length >= options.limit) {
          truncated = true;
          return false;
        }
      });
    } catch {
      // 读不了的文件跳过
    }
  }
  return { hits, truncated };
}
