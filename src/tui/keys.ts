/**
 * 键解析（设计 §12.3）。[B4]
 *
 * 支持：C0 控制字符（Ctrl 组合）、CSI / SS3 光标与功能键、xterm 修饰键参数（`ESC[1;5A`）、
 * `CSI u`（`ESC[13;2u`）与 modifyOtherKeys（`ESC[27;2;13~`）两种扩展形式、Alt 前缀（`ESC x`）。
 * **不查询 Kitty 键盘协议**（tmux 下回包会污染输入）；只被动解析终端自发的扩展序列。
 *
 * KeyId 形如 `ctrl+shift+up`：修饰键按 ctrl → alt → shift 排序，键名小写；
 * 可打印字符的键名就是字符本身（`a`、`/`、`中`），空格为 `space`。
 */

export interface KeyEvent {
  /** 键名：`enter`、`up`、`f5`、`a`、`中` …… */
  readonly name: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** 规范化 KeyId：修饰键 + 键名。 */
  readonly id: string;
  /** 产生可打印文本时为该文本（不含修饰键组合）。 */
  readonly text?: string;
}

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

function makeKey(name: string, mods: Mods, text?: string): KeyEvent {
  const parts: string[] = [];
  if (mods.ctrl) parts.push("ctrl");
  if (mods.alt) parts.push("alt");
  if (mods.shift) parts.push("shift");
  parts.push(name);
  const base = { name, ctrl: mods.ctrl, alt: mods.alt, shift: mods.shift, id: parts.join("+") };
  return text === undefined ? base : { ...base, text };
}

/** xterm 修饰参数：值 = 1 + 位掩码（1 shift，2 alt，4 ctrl，8 meta→按 alt 处理）。 */
function modsFromParam(param: number | undefined): Mods {
  if (param === undefined || !Number.isFinite(param) || param < 1) return NO_MODS;
  const bits = param - 1;
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0 || (bits & 8) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}

const CSI_LETTER: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  E: "clear",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const CSI_TILDE: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

/** 码点（CSI u / modifyOtherKeys）→ 键名。 */
function nameFromCodePoint(cp: number): string | undefined {
  switch (cp) {
    case 13:
      return "enter";
    case 9:
      return "tab";
    case 27:
      return "escape";
    case 127:
    case 8:
      return "backspace";
    case 32:
      return "space";
    default:
      if (cp < 32) return undefined;
      return String.fromCodePoint(cp).toLowerCase();
  }
}

function parseCsi(body: string, final: string): KeyEvent | undefined {
  // body：ESC[ 与终止字节之间的参数部分
  if (body.startsWith("<") || body.startsWith("?") || body.startsWith(">")) return undefined;
  const params = body.split(";").map((p) => (p === "" ? undefined : Number(p.split(":")[0])));
  if (final === "u") {
    const cp = params[0];
    if (cp === undefined) return undefined;
    const name = nameFromCodePoint(cp);
    return name === undefined ? undefined : makeKey(name, modsFromParam(params[1]));
  }
  if (final === "~") {
    const first = params[0];
    if (first === 27 && params.length >= 3) {
      // modifyOtherKeys：ESC[27;<mod>;<code>~
      const name = nameFromCodePoint(params[2] ?? -1);
      return name === undefined ? undefined : makeKey(name, modsFromParam(params[1]));
    }
    if (first === 200 || first === 201) return undefined;
    const name = first === undefined ? undefined : CSI_TILDE[first];
    return name === undefined ? undefined : makeKey(name, modsFromParam(params[1]));
  }
  if (final === "Z") return makeKey("tab", { ...modsFromParam(params[1]), shift: true });
  const name = CSI_LETTER[final];
  if (name === undefined) return undefined;
  return makeKey(name, modsFromParam(params.length > 1 ? params[1] : undefined));
}

const SS3: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  M: "enter",
};

function parseControl(code: number): KeyEvent | undefined {
  switch (code) {
    case 0x0d:
      return makeKey("enter", NO_MODS);
    case 0x0a:
      return makeKey("j", { ...NO_MODS, ctrl: true });
    case 0x09:
      return makeKey("tab", NO_MODS);
    case 0x7f:
    case 0x08:
      return makeKey("backspace", NO_MODS);
    case 0x1b:
      return makeKey("escape", NO_MODS);
    case 0x00:
      return makeKey("space", { ...NO_MODS, ctrl: true });
    case 0x1c:
      return makeKey("\\", { ...NO_MODS, ctrl: true });
    case 0x1d:
      return makeKey("]", { ...NO_MODS, ctrl: true });
    case 0x1e:
      return makeKey("^", { ...NO_MODS, ctrl: true });
    case 0x1f:
      return makeKey("-", { ...NO_MODS, ctrl: true });
    default:
      if (code >= 0x01 && code <= 0x1a) {
        return makeKey(String.fromCharCode(code + 0x60), { ...NO_MODS, ctrl: true });
      }
      return undefined;
  }
}

function withAlt(key: KeyEvent): KeyEvent {
  return makeKey(key.name, { ctrl: key.ctrl, alt: true, shift: key.shift });
}

function parsePrintable(data: string): KeyEvent | undefined {
  const cp = data.codePointAt(0);
  if (cp === undefined || cp < 0x20 || cp === 0x7f) return undefined;
  if (data === " ") return makeKey("space", NO_MODS, " ");
  const lower = data.toLowerCase();
  const shift = lower !== data && data.length === 1;
  return makeKey(lower, { ...NO_MODS, shift }, data);
}

/**
 * 解析一个完整的键序列（StdinBuffer 已按序列切分）。无法识别返回 undefined。
 * 多个字符的纯文本（例如非括号粘贴）不算单个键，同样返回 undefined。
 */
export function parseKey(data: string): KeyEvent | undefined {
  if (data.length === 0) return undefined;
  const first = data.charCodeAt(0);
  if (first !== 0x1b) {
    if (data.length === 1) return parseControl(first) ?? parsePrintable(data);
    // 单个非 BMP 字符或组合字素
    if ([...data].length === 1 || isSingleGrapheme(data)) return parsePrintable(data);
    return undefined;
  }
  if (data.length === 1) return makeKey("escape", NO_MODS);
  const second = data[1]!;
  if (second === "[") {
    const final = data[data.length - 1]!;
    if (data.length >= 3) return parseCsi(data.slice(2, -1), final);
    return makeKey("[", { ...NO_MODS, alt: true }, undefined);
  }
  if (second === "O" && data.length === 3) {
    const name = SS3[data[2]!];
    return name === undefined ? undefined : makeKey(name, NO_MODS);
  }
  // Alt 前缀：ESC + 另一序列
  const rest = data.slice(1);
  const inner = parseKey(rest);
  if (inner === undefined) return undefined;
  return withAlt(inner);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isSingleGrapheme(data: string): boolean {
  let count = 0;
  for (const _ of graphemeSegmenter.segment(data)) {
    count++;
    if (count > 1) return false;
  }
  return count === 1;
}

/** 规范化 KeyId 字符串：修饰键重排、别名（return→enter、esc→escape、del→delete）。 */
export function normalizeKeyId(id: string): string {
  const parts = id.toLowerCase().split("+");
  // "ctrl++" 这类以 + 为键名的写法
  if (id.endsWith("++")) {
    parts.splice(parts.length - 2, 2, "+");
  }
  const name = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => (p === "option" || p === "meta" ? "alt" : p)));
  const alias: Record<string, string> = {
    return: "enter",
    esc: "escape",
    del: "delete",
    bs: "backspace",
    pgup: "pageup",
    pgdn: "pagedown",
    " ": "space",
  };
  const finalName = alias[name] ?? name;
  return makeKey(finalName, {
    ctrl: mods.has("ctrl"),
    alt: mods.has("alt"),
    shift: mods.has("shift"),
  }).id;
}

/** 数据是否匹配给定 KeyId（`shift+a` 与大写 `A` 视为同一键）。 */
export function matchesKey(data: string, keyId: string): boolean {
  const key = parseKey(data);
  if (key === undefined) return false;
  return key.id === normalizeKeyId(keyId);
}

/** 是否为括号粘贴包裹的数据（StdinBuffer 产出的一次 paste 事件）。 */
export function isPasteData(data: string): boolean {
  return data.startsWith(PASTE_START) && data.endsWith(PASTE_END);
}

/** 取出括号粘贴的正文。 */
export function unwrapPaste(data: string): string {
  return data.slice(PASTE_START.length, data.length - PASTE_END.length);
}

/** 数据是否为可直接插入的文本（不含控制字符与转义序列）。 */
export function isPrintableText(data: string): boolean {
  if (data.length === 0) return false;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}
