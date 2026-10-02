/**
 * 字形表与 ASCII 回退（终端界面视觉设计 v1 §2.2）。
 *
 * 所有组件通过 `theme.glyphs` 取字形，不另加参数；`UNICODE_GLYPHS` 里每个字形都是 1 列宽
 * （`codePointWidth` 判定，与 wcwidth 一致；个别字体把 `⏺` 画成两格时用 `AMA_ASCII=1`）。
 *
 * ASCII 触发：`ui.ascii: true` / `AMA_ASCII=1`，或自动检测——区域设置（`LC_ALL` > `LC_CTYPE` > `LANG`）
 * 已设置但不含 UTF-8、`TERM=linux`、Windows 上 `WT_SESSION` 与 `TERM_PROGRAM` 都为空（旧 conhost）。
 * `AMA_ASCII=0` 强制 Unicode。区域变量都没设时按 Unicode 处理（容器与 CI 里常见）。
 */

export interface BoxGlyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly vertical: string;
  readonly horizontal: string;
}

export interface Glyphs {
  /** 是否 ASCII 回退表。 */
  readonly ascii: boolean;
  /** 用户消息、输入框提示符。 */
  readonly prompt: string;
  /** 工具调用标题。 */
  readonly tool: string;
  /** 结果连接符。 */
  readonly result: string;
  readonly ok: string;
  readonly fail: string;
  readonly warn: string;
  /** 思考块、启动头标识。 */
  readonly thinking: string;
  /** 排队消息。 */
  readonly queued: string;
  /** 重试提示。 */
  readonly retry: string;
  /** Hook 阻止提示。 */
  readonly blocked: string;
  /** 左侧竖条卡片。 */
  readonly card: string;
  readonly expand: string;
  readonly collapse: string;
  /** 缓存保温。 */
  readonly warm: string;
  /** 当前项（选择器里打勾）。 */
  readonly check: string;
  /** 列表圆点（按嵌套深度循环）。 */
  readonly bullets: readonly string[];
  readonly meterFull: string;
  readonly meterEmpty: string;
  readonly box: BoxGlyphs;
  /** 规则线（输入框上下、分隔线）。 */
  readonly rule: string;
  /** Loader 帧。 */
  readonly spinner: readonly string[];
  /** 静态 spinner（`ui.animation: false`）。 */
  readonly spinnerStatic: string;
  readonly ellipsis: string;
  readonly arrowUp: string;
  readonly arrowDown: string;
}

export const UNICODE_GLYPHS: Glyphs = {
  ascii: false,
  prompt: "›",
  tool: "⏺",
  result: "⎿",
  ok: "✓",
  fail: "✗",
  warn: "!",
  thinking: "✻",
  queued: "↳",
  retry: "↻",
  blocked: "⛔",
  card: "▎",
  expand: "▸",
  collapse: "▾",
  warm: "♨",
  check: "✓",
  bullets: ["•", "◦", "▪"],
  meterFull: "▮",
  meterEmpty: "▯",
  box: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    vertical: "│",
    horizontal: "─",
  },
  rule: "─",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  spinnerStatic: "·",
  ellipsis: "…",
  arrowUp: "↑",
  arrowDown: "↓",
};

export const ASCII_GLYPHS: Glyphs = {
  ascii: true,
  prompt: ">",
  tool: "*",
  result: "L",
  ok: "v",
  fail: "x",
  warn: "!",
  thinking: "~",
  queued: "->",
  retry: "@",
  blocked: "X",
  card: "|",
  expand: ">",
  collapse: "v",
  warm: "~",
  check: "v",
  bullets: ["-", "*", "+"],
  meterFull: "#",
  meterEmpty: ".",
  box: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    vertical: "|",
    horizontal: "-",
  },
  rule: "-",
  spinner: ["-", "\\", "|", "/"],
  spinnerStatic: ".",
  ellipsis: "...",
  arrowUp: "^",
  arrowDown: "v",
};

function truthy(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const v = value.toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

/** 由环境判断是否用 ASCII 字形（`AMA_ASCII` 优先）。 */
export function detectAscii(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const forced = truthy(env["AMA_ASCII"]);
  if (forced !== undefined) return forced;
  const locale = env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"] || "";
  if (locale !== "" && !/utf-?8/i.test(locale)) return true;
  if ((env["TERM"] ?? "") === "linux") return true;
  if (platform === "win32" && !env["WT_SESSION"] && !env["TERM_PROGRAM"]) return true;
  return false;
}

export function glyphsFor(ascii: boolean): Glyphs {
  return ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
}
