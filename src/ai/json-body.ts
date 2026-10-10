/**
 * 请求体序列化（docs/memory-plan.md D3、§2.3）。
 *
 * 带图请求体里 base64 占绝大部分字节；`JSON.stringify(body)` 会先拼出整份中间字符串，再由 fetch
 * 编码成 UTF-8。这里先廉价扫一遍：没有 ≥ {@link LARGE_STRING_BYTES} 的字符串就照旧走原生；有就只沿
 * 「普通对象 / 数组」结构拼片段——小子树仍交给原生 `JSON.stringify`，大字符串经检查无需转义时原样
 * 作为一个片段。片段两种用法：`serializeJsonBody` 一次分配结果 Buffer 依次写入；`jsonFetchBody`
 * （`postJson` 用）逐片段编码成流、声明总字节数，不在内存里留整份请求体。
 *
 * 结果与 `Buffer.from(JSON.stringify(body), "utf8")` 逐字节相同：自写部分只有结构（`{`、`,`、
 * 键、`[`）与已验证无需转义的大字符串（需要转义的大字符串整个交给原生）；`toJSON`、`undefined` /
 * 函数 / symbol 的跳过与 `null`、数字格式、转义全部由原生处理（带 `toJSON` 的值经单键容器序列化，
 * 保证 `toJSON(key)` 收到与原生相同的键）。
 *
 * 图片由转换器包成 {@link LargeString}（`prefix + text`）：片段路径直接写转录里的原字符串，不经模板串
 * 拼接后的扁平化；无需转义的结论与字节数按 ImageBlock 缓存，同一张图每进程只扫一次。流式发送时大片段
 * 按 {@link STREAM_CHUNK_CHARS} 切块编码。
 */

/** 达到这个长度（UTF-16 码元）的字符串才走片段路径。 */
export const LARGE_STRING_BYTES = 64 * 1024;

/** 检查是否需要转义时每次交给原生的长度：结果是新生代里的小字符串，随即可回收。 */
const CHECK_CHUNK = 16 * 1024;

/**
 * 大字符串无需转义、可原样写入：逐段让原生 `JSON.stringify` 判断（长度恰好多出两个引号即没有
 * 任何转义）。引号、反斜杠、控制字符、孤立代理项都会让长度变化；成对代理项若恰被切在段界上
 * 也会被判为需要转义——只会多走原生，不会错。实测比同义的正则快一倍多（原生的转义扫描是向量化的）。
 * 每个大字符串每次序列化只查这一次。
 */
function isPlain(value: string): boolean {
  plainScans.count++;
  for (let i = 0; i < value.length; i += CHECK_CHUNK) {
    const chunk = value.slice(i, i + CHECK_CHUNK);
    if (JSON.stringify(chunk).length !== chunk.length + 2) return false;
  }
  return true;
}

/** 短字符串无需转义（`LargeString.prefix` 用）。 */
const isShortPlain = (value: string): boolean => JSON.stringify(value).length === value.length + 2;

/** `isPlain` 的调用次数（测试用：同一块图片第二次序列化不应再扫）。 */
export const plainScans = { count: 0 };

/**
 * 请求体里的大字符串叶子 `prefix + text`（data URL 或裸 base64），用来代替模板串拼接：拼接得到的
 * cons string 在每次序列化时都会被扁平化成一份新的整图字符串。片段路径直接写 `prefix` 与 `text`
 * （`text` 是转录里的原字符串，不拷贝）；`text` 无需转义的结论按 `key`（转录里身份稳定的 ImageBlock）
 * 缓存，同一块每进程只扫一次。约定：同一 `key` 的 `text` 不变。其它遍历者看到的是一个带 `toJSON`
 * 的对象，原生 `JSON.stringify` 得到相同字符串。由 {@link largeString} 构造。
 */
export class LargeString {
  constructor(
    readonly prefix: string,
    readonly key: object,
    readonly text: string,
  ) {}

  toJSON(): string {
    return this.prefix + this.text;
  }
}

/**
 * `prefix + text` 作为请求体的值：`text` 够大且 `prefix` 自身无需转义时给 {@link LargeString}，
 * 否则就是拼好的字符串（小图与以前完全相同）。
 */
export function largeString(prefix: string, key: object, text: string): string | LargeString {
  if (text.length < LARGE_STRING_BYTES || !isShortPlain(prefix)) return prefix + text;
  return new LargeString(prefix, key, text);
}

/** 已确认无需转义的 `LargeString.text`：键是 `key`，值是当时的 UTF-8 字节数（同时省掉再数一遍）。 */
const plainBytes = new WeakMap<object, { length: number; bytes: number }>();

/** `LargeString.text` 可原样写入时返回其 UTF-8 字节数，否则 undefined。 */
function plainLargeBytes(value: LargeString): number | undefined {
  if (!isShortPlain(value.prefix)) return undefined;
  const known = plainBytes.get(value.key);
  if (known !== undefined && known.length === value.text.length) return known.bytes;
  if (!isPlain(value.text)) return undefined;
  const bytes = Buffer.byteLength(value.text, "utf8");
  plainBytes.set(value.key, { length: value.text.length, bytes });
  return bytes;
}

/** 结构遍历的深度上限：更深（或有环）时整棵子树交给原生，环由原生照常抛 TypeError。 */
const MAX_DEPTH = 64;

type Container = Record<string, unknown> | unknown[];

const isLargeString = (value: unknown): value is string =>
  typeof value === "string" && value.length >= LARGE_STRING_BYTES;

/** 只遍历原型为 Object.prototype / null 的普通对象和数组，且自身与原型链上都没有 `toJSON`。 */
function isContainer(value: unknown): value is Container {
  if (typeof value !== "object" || value === null) return false;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return false;
  if (Array.isArray(value)) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 收集含大字符串的容器（片段路径只深入这些容器）；返回 `value` 本身是否含大字符串。 */
function collectLarge(value: unknown, marked: Set<Container>, depth: number): boolean {
  if (isLargeString(value)) return true;
  if (value instanceof LargeString) return value.text.length >= LARGE_STRING_BYTES;
  if (depth >= MAX_DEPTH || !isContainer(value)) return false;
  let found = false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (collectLarge(value[i], marked, depth + 1)) found = true;
    }
  } else {
    for (const key of Object.keys(value)) {
      if (collectLarge(value[key], marked, depth + 1)) found = true;
    }
  }
  if (found) marked.add(value);
  return found;
}

/** 原生序列化 `holder[key] = value` 这一项的值；被原生跳过（undefined / 函数 / symbol）时 undefined。 */
function nativeValue(key: string, value: unknown): string | undefined {
  if (typeof value !== "object" && typeof value !== "function" && typeof value !== "bigint") {
    return JSON.stringify(value) as string | undefined;
  }
  // 对象、函数与 bigint 可能有 toJSON(key)：放进单键容器，让原生以同一个键调用
  const wrapped = JSON.stringify({ [key]: value });
  if (wrapped === "{}") return undefined;
  return wrapped.slice(JSON.stringify(key).length + 2, -1);
}

/** 片段：已拼好的 JSON 文本与大字符串交替；连续的小文本先在字符串里累积。 */
class Pieces {
  readonly parts: string[] = [];
  /** 已推入 `parts` 的 UTF-8 字节数。 */
  bytes = 0;
  private pending = "";

  text(chunk: string): void {
    this.pending += chunk;
  }

  /** 大字符串原样写入（引号与 `head` 进前一个小片段）；`bytes` 已知时不再数一遍。 */
  large(value: string, head = "", bytes = Buffer.byteLength(value, "utf8")): void {
    const before = `${this.pending}"${head}`;
    this.parts.push(before, value);
    this.bytes += Buffer.byteLength(before, "utf8") + bytes;
    this.pending = '"';
  }

  finish(): string[] {
    if (this.pending.length > 0) {
      this.parts.push(this.pending);
      this.bytes += Buffer.byteLength(this.pending, "utf8");
    }
    this.pending = "";
    return this.parts;
  }
}

/** 写一项的值；返回是否写了（对象里被原生跳过的属性不写）。数组里跳过的值写 `null`。 */
function writeEntry(
  key: string,
  value: unknown,
  marked: Set<Container>,
  out: Pieces,
  prefix: string,
  depth: number,
): boolean {
  if (isLargeString(value)) {
    if (isPlain(value)) {
      out.text(prefix);
      out.large(value);
    } else {
      out.text(prefix + JSON.stringify(value)); // 需要转义：只有这一个字符串交给原生
    }
    return true;
  }
  if (value instanceof LargeString && value.text.length >= LARGE_STRING_BYTES) {
    const bytes = plainLargeBytes(value);
    out.text(prefix);
    if (bytes !== undefined) out.large(value.text, value.prefix, bytes);
    else out.text(JSON.stringify(value.toJSON())); // 需要转义：交给原生
    return true;
  }
  // 深度与 collectLarge 一致；有环时越过上限交给原生，由它抛 TypeError
  if (depth < MAX_DEPTH && isContainer(value) && marked.has(value)) {
    out.text(prefix);
    writeContainer(value, marked, out, depth);
    return true;
  }
  const text = nativeValue(key, value);
  if (text === undefined) return false;
  out.text(prefix + text);
  return true;
}

function writeContainer(
  value: Container,
  marked: Set<Container>,
  out: Pieces,
  depth: number,
): void {
  if (Array.isArray(value)) {
    out.text("[");
    for (let i = 0; i < value.length; i++) {
      const prefix = i > 0 ? "," : "";
      if (!writeEntry(String(i), value[i], marked, out, prefix, depth + 1))
        out.text(`${prefix}null`);
    }
    out.text("]");
    return;
  }
  out.text("{");
  let first = true;
  for (const key of Object.keys(value)) {
    const prefix = `${first ? "" : ","}${JSON.stringify(key)}:`;
    if (writeEntry(key, value[key], marked, out, prefix, depth + 1)) first = false;
  }
  out.text("}");
}

/**
 * 含大字符串时按顺序给出各片段（拼起来就是 `JSON.stringify(body)`）与 UTF-8 总字节数；
 * 不含时返回 undefined（调用方照旧走原生）。
 */
function jsonParts(body: unknown): { parts: string[]; length: number } | undefined {
  const marked = new Set<Container>();
  if (!collectLarge(body, marked, 0)) return undefined;
  const out = new Pieces();
  writeEntry("", body, marked, out, "", 0); // 顶层：键为 ""，与原生调用 toJSON 的键相同
  const parts = out.finish();
  return { parts, length: out.bytes };
}

/** 与 `Buffer.from(JSON.stringify(body), "utf8")` 逐字节相同；大字符串不经中间字符串。 */
export function serializeJsonBody(body: unknown): Buffer {
  const split = jsonParts(body);
  if (split === undefined) return Buffer.from(JSON.stringify(body), "utf8");
  // 一次分配、依次写入：不再有整份中间字符串，也不需要 Buffer.concat 的第二份拷贝
  const buf = Buffer.allocUnsafe(split.length);
  let offset = 0;
  for (const part of split.parts) offset += buf.write(part, offset, "utf8");
  if (offset !== split.length) {
    throw new Error(`serializeJsonBody: wrote ${offset} of ${split.length} bytes`);
  }
  return buf;
}

/** `postJson` 交给 fetch 的请求体。 */
export interface JsonFetchBody {
  body: string | ReadableStream<Uint8Array>;
  /** 流式请求体的字节数：调用方须作为 `content-length` 头发出（不走 chunked）。 */
  contentLength?: number;
}

/**
 * 流式请求体每块最多编码的码元数：大片段（一整张图）按游标切片（V8 切片串不拷贝）逐块编码，
 * 发送期间只多出一块的 UTF-8 字节，而不是一整张图。
 */
export const STREAM_CHUNK_CHARS = 256 * 1024;

/**
 * 给 fetch 的请求体。不含大字符串时就是 `JSON.stringify(body)`（与以前完全相同）；含大字符串时是
 * 逐片段编码的流，并给出总字节数。不交给 fetch 一个 Buffer：Node 的 fetch 会把 BufferSource
 * 请求体再复制两份（实测 mock 300 步带图峰值反而从约 1.0 GB 升到 1.85 GB），流则按片段边读边发，
 * 同一时刻只多出一块（≤ {@link STREAM_CHUNK_CHARS} 码元）的 UTF-8 字节。字节序列与 `serializeJsonBody` 相同。
 */
export function jsonFetchBody(body: unknown): JsonFetchBody {
  const split = jsonParts(body);
  if (split === undefined) return { body: JSON.stringify(body) };
  const { parts } = split;
  let next = 0;
  let offset = 0; // 当前片段已发出的码元数
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[next];
      if (part === undefined) {
        controller.close();
        return;
      }
      let end = Math.min(part.length, offset + STREAM_CHUNK_CHARS);
      // 不把成对代理项切开（片段里只有成对的：孤立代理项已被原生转义）
      const last = part.charCodeAt(end - 1);
      if (end < part.length && last >= 0xd800 && last <= 0xdbff) end--;
      const piece = offset === 0 && end === part.length ? part : part.slice(offset, end);
      if (end === part.length) {
        parts[next++] = ""; // 发完即放手，片段（拼出来的小文本）可尽早回收
        offset = 0;
      } else offset = end;
      controller.enqueue(Buffer.from(piece, "utf8"));
    },
    cancel() {
      parts.length = 0;
    },
  });
  return { body: stream, contentLength: split.length };
}
