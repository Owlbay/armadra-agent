/**
 * 容错 JSON 片段解析（设计 §1.2 ai/json-partial.ts）：流式 tool_call 参数在每个增量后都要
 * 能给出「到目前为止」的对象；结束时参数也可能有小毛病（字符串里的裸控制字符、非法转义）。
 *
 * `parsePartialJson` 是一个宽松的递归下降解析器：
 * - 输入在任意位置截断都返回已解析的部分（未完成的字符串保留已收到的字符；未完成的键、
 *   只有键没有值的成员被丢弃；未完成的数字取能解析的前缀；未完成的字面量按前缀补全）；
 * - 字符串内的裸控制字符照收，非法转义 `\x` 保留为两个字符；
 * - 遇到无法继续的语法错误时返回到错误点为止已解析的部分。
 */

class Cursor {
  pos = 0;
  constructor(readonly text: string) {}
  get done(): boolean {
    return this.pos >= this.text.length;
  }
  peek(): string {
    return this.text.charAt(this.pos);
  }
  skipWs(): void {
    while (this.pos < this.text.length && /\s/.test(this.text.charAt(this.pos))) this.pos++;
  }
}

/** 解析失败（语法错误）时抛出，携带已解析的部分值。 */
class Stop extends Error {
  constructor(readonly partial: unknown) {
    super("stop");
  }
}

const NONE = Symbol("none");
type Parsed = unknown | typeof NONE;

function parseValue(c: Cursor): Parsed {
  c.skipWs();
  if (c.done) return NONE;
  const ch = c.peek();
  if (ch === "{") return parseObject(c);
  if (ch === "[") return parseArray(c);
  if (ch === '"') return parseString(c);
  if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber(c);
  return parseLiteral(c);
}

function parseObject(c: Cursor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  c.pos++; // {
  while (true) {
    c.skipWs();
    if (c.done) return out;
    const ch = c.peek();
    if (ch === "}") {
      c.pos++;
      return out;
    }
    if (ch === ",") {
      c.pos++;
      continue;
    }
    if (ch !== '"') throw new Stop(out);
    const start = c.pos;
    const key = parseString(c);
    if (c.pos === start) throw new Stop(out);
    c.skipWs();
    if (c.done) return out;
    if (c.peek() !== ":") throw new Stop(out);
    c.pos++;
    let value: Parsed;
    try {
      value = parseValue(c);
    } catch (error) {
      if (error instanceof Stop) {
        if (error.partial !== NONE) out[key] = error.partial;
        throw new Stop(out);
      }
      throw error;
    }
    if (value === NONE) return out;
    out[key] = value;
  }
}

function parseArray(c: Cursor): unknown[] {
  const out: unknown[] = [];
  c.pos++; // [
  while (true) {
    c.skipWs();
    if (c.done) return out;
    const ch = c.peek();
    if (ch === "]") {
      c.pos++;
      return out;
    }
    if (ch === ",") {
      c.pos++;
      continue;
    }
    let value: Parsed;
    try {
      value = parseValue(c);
    } catch (error) {
      if (error instanceof Stop) {
        if (error.partial !== NONE) out.push(error.partial);
        throw new Stop(out);
      }
      throw error;
    }
    if (value === NONE) return out;
    out.push(value);
  }
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function parseString(c: Cursor): string {
  let out = "";
  c.pos++; // "
  while (!c.done) {
    const ch = c.text.charAt(c.pos);
    if (ch === '"') {
      c.pos++;
      return out;
    }
    if (ch !== "\\") {
      out += ch;
      c.pos++;
      continue;
    }
    const next = c.text.charAt(c.pos + 1);
    if (next === "") {
      c.pos = c.text.length; // 截断在转义中间：丢掉反斜杠
      return out;
    }
    if (next === "u") {
      const hex = c.text.slice(c.pos + 2, c.pos + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        c.pos += 6;
        continue;
      }
      if (c.pos + 6 > c.text.length && /^[0-9a-fA-F]*$/.test(hex)) {
        c.pos = c.text.length; // 截断在 \uXXXX 中间
        return out;
      }
    }
    const mapped = ESCAPES[next];
    if (mapped !== undefined) out += mapped;
    else out += `\\${next}`; // 非法转义：原样保留
    c.pos += 2;
  }
  return out;
}

function parseNumber(c: Cursor): number | typeof NONE {
  const match = /^-?(?:\d+)?(?:\.\d*)?(?:[eE][+-]?\d*)?/.exec(c.text.slice(c.pos));
  const raw = match?.[0] ?? "";
  c.pos += raw.length;
  for (let end = raw.length; end > 0; end--) {
    const value = Number(raw.slice(0, end));
    if (raw.slice(0, end) !== "-" && Number.isFinite(value)) return value;
  }
  if (raw.length === 0) throw new Stop(NONE);
  return NONE;
}

const LITERALS: [string, unknown][] = [
  ["true", true],
  ["false", false],
  ["null", null],
];

function parseLiteral(c: Cursor): unknown {
  const rest = c.text.slice(c.pos);
  for (const [word, value] of LITERALS) {
    if (rest.startsWith(word)) {
      c.pos += word.length;
      return value;
    }
    if (rest.length < word.length && word.startsWith(rest)) {
      c.pos = c.text.length;
      return value;
    }
  }
  throw new Stop(NONE);
}

/** 宽松解析（见文件头）；无可解析内容时返回 undefined。 */
export function parsePartialJson(text: string): unknown {
  const cursor = new Cursor(text);
  try {
    const value = parseValue(cursor);
    return value === NONE ? undefined : value;
  } catch (error) {
    if (error instanceof Stop) return error.partial === NONE ? undefined : error.partial;
    throw error;
  }
}

/** 先严格解析，失败再宽松解析。 */
export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return parsePartialJson(text);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 工具调用参数：结果总是对象（流契约要求 toolcall_end 时参数为合法对象）。 */
export function parseToolArguments(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  const value = parseJsonLenient(text);
  return isPlainObject(value) ? value : {};
}
