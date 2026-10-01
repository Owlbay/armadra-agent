/**
 * YAML 头**子集**解析（设计 §5.3、§2「YAML 只支持 frontmatter 子集自写」）。[B3]
 *
 * 支持：首行 `---` 到下一个 `---` / `...` 之间的
 * - `key: value`（值为裸字串、单 / 双引号字串、`true/false`、整数 / 小数、`null` / `~`）；
 * - 行内数组 `key: [a, "b", 3]`；块数组（`key:` 后跟 `- item` 行）；
 * - `#` 注释（引号外）与空行。
 * 不支持：嵌套映射、多行块标量（`|` / `>`）、锚点——遇到时记一条错误并跳过该键。
 */

export type FrontmatterValue = string | number | boolean | null | FrontmatterScalar[];
type FrontmatterScalar = string | number | boolean | null;

export interface FrontmatterResult {
  data: Record<string, FrontmatterValue>;
  /** 头之后的正文（无头时为全文）。 */
  body: string;
  /** 是否有头。 */
  hasFrontmatter: boolean;
  errors: string[];
}

function stripComment(text: string): string {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1] ?? ""))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function unquote(text: string): string | undefined {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return undefined;
}

export function parseScalar(raw: string): FrontmatterScalar {
  const text = raw.trim();
  const quoted = unquote(text);
  if (quoted !== undefined) return quoted;
  if (text === "" || text === "null" || text === "~") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function splitInlineArray(inner: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = undefined;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      out.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim() !== "") out.push(current);
  return out;
}

/** 拆出头与正文；不以 `---` 开头视为无头。 */
export function splitFrontmatter(text: string): { header: string[] | undefined; body: string } {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return { header: undefined, body: normalized };
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]?.trim();
    if (t === "---" || t === "...") {
      return { header: lines.slice(1, i), body: lines.slice(i + 1).join("\n") };
    }
  }
  return { header: undefined, body: normalized };
}

export function parseFrontmatter(text: string): FrontmatterResult {
  const { header, body } = splitFrontmatter(text);
  const result: FrontmatterResult = {
    data: {},
    body,
    hasFrontmatter: header !== undefined,
    errors: [],
  };
  if (!header) return result;
  let listKey: string | undefined;
  const emptyKeys = new Set<string>();
  header.forEach((rawLine, index) => {
    const lineNo = index + 2;
    const line = stripComment(rawLine);
    if (line.trim() === "") return;
    const item = /^\s+-\s*(.*)$|^-\s+(.*)$/.exec(line);
    if (item && listKey !== undefined) {
      const arr = result.data[listKey];
      if (Array.isArray(arr)) arr.push(parseScalar(item[1] ?? item[2] ?? ""));
      emptyKeys.delete(listKey);
      return;
    }
    if (/^\s/.test(line)) {
      result.errors.push(`line ${lineNo}: nested values are not supported`);
      return;
    }
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (!m) {
      result.errors.push(`line ${lineNo}: expected "key: value"`);
      listKey = undefined;
      return;
    }
    const key = m[1] as string;
    const value = (m[2] ?? "").trim();
    listKey = undefined;
    if (value === "") {
      result.data[key] = [];
      listKey = key;
      emptyKeys.add(key);
    } else if (value === "|" || value === ">" || /^[|>][+-]?$/.test(value)) {
      result.errors.push(`line ${lineNo}: block scalars are not supported (key "${key}")`);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result.data[key] = splitInlineArray(value.slice(1, -1)).map(parseScalar);
    } else if (value.startsWith("{")) {
      result.errors.push(`line ${lineNo}: inline mappings are not supported (key "${key}")`);
    } else {
      result.data[key] = parseScalar(value);
    }
  });
  // `key:` 后没有列表项 → null。
  for (const key of emptyKeys) result.data[key] = null;
  return result;
}
