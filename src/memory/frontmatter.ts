/**
 * 记忆条目的 frontmatter（docs/history/wave6-plan.md §3.2）。[W6-M]
 *
 * ```markdown
 * ---
 * name: 测试数据库重置
 * description: 跑集成测试前要先执行的重置命令
 * type: project        # user | feedback | project | reference
 * updated: 2026-10-03
 * ---
 *
 * 正文
 * ```
 *
 * 只认单行 `key: value`（值可带成对引号）；未知键保留原顺序。写入时规范化：`name` 缺省用文件名、
 * `description` 缺省用正文首个非空行、`type` 不在四类里用作用域缺省、`updated` 总是写当天。
 */

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

const ORDER = ["name", "description", "type", "updated"];
const MAX_DESCRIPTION = 150;

export interface ParsedEntry {
  meta: Record<string, string>;
  body: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  )
    return v.slice(1, -1);
  return v;
}

export function parseEntry(text: string): ParsedEntry {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) return { meta: {}, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: normalized };
  const after = normalized.slice(end + 4);
  if (after !== "" && !after.startsWith("\n")) return { meta: {}, body: normalized };
  const meta: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m?.[1] !== undefined) meta[m[1]] = unquote(m[2] ?? "");
  }
  return { meta, body: after.replace(/^\n+/, "") };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 正文首个非空行（去掉标题井号），截到 150 字符。 */
export function firstLineOf(body: string): string {
  for (const raw of body.split("\n")) {
    const line = oneLine(raw.replace(/^#+\s*/, ""));
    if (line !== "")
      return line.length > MAX_DESCRIPTION ? `${line.slice(0, MAX_DESCRIPTION - 1)}…` : line;
  }
  return "";
}

export function serializeEntry(meta: Record<string, string>, body: string): string {
  const keys = [
    ...ORDER.filter((k) => meta[k] !== undefined),
    ...Object.keys(meta).filter((k) => !ORDER.includes(k)),
  ];
  const lines = keys.map((k) => `${k}: ${oneLine(meta[k] ?? "")}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

/** 写入前规范化：补全 name / description / type，`updated` 写 `today`。 */
export function normalizeEntry(
  text: string,
  defaults: { name: string; type: MemoryType; today: string },
): { text: string; meta: Record<string, string>; body: string } {
  const parsed = parseEntry(text);
  const meta = { ...parsed.meta };
  const body = parsed.body.trim();
  if (oneLine(meta["name"] ?? "") === "") meta["name"] = defaults.name;
  if (oneLine(meta["description"] ?? "") === "") meta["description"] = firstLineOf(body);
  if (!(MEMORY_TYPES as readonly string[]).includes(meta["type"] ?? ""))
    meta["type"] = defaults.type;
  meta["updated"] = defaults.today;
  return { text: serializeEntry(meta, body), meta, body };
}
