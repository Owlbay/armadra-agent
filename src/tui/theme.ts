/**
 * 主题与颜色能力（设计 §12.7）。[B4]
 *
 * - `dark` / `light` 两套语义色（14 个名字，终端界面视觉设计 v1 §2.1），以 24 位 RGB 定义；取值都落在
 *   xterm 256 色立方 / 灰阶上，所以 256 色回退无损。
 * - 能力降级：truecolor → 256 色（6×6×6 立方 + 灰阶取近）→ 16 色（内置色板按 `THEME_ANSI16` 查表，
 *   覆盖色按 xterm 缺省调色板取近）→ 无色。
 * - `bg("selection")` 在 < 256 色时退化为 `accent` 粗体前景（16 色下底色太跳，且常留「尾巴」）。
 * - `NO_COLOR`（非空）或 `TERM=dumb` → 无色；不探测终端背景（不发查询序列）。
 * - 样式用各自的关闭码（39 / 49 / 22 / 23 / 24）而不是全重置，可以嵌套。
 */

import type { ColorDepth, SemanticColor, Theme, ThemeCapabilities } from "./component.js";
import { detectAscii, glyphsFor, type Glyphs } from "./glyphs.js";

export type ThemeName = "dark" | "light";

type Rgb = readonly [number, number, number];

export const THEME_PALETTES: Record<ThemeName, Record<SemanticColor, string>> = {
  dark: {
    text: "#e4e4e4",
    muted: "#a8a8a8",
    dim: "#6c6c6c",
    accent: "#5fafff",
    success: "#5fd787",
    warning: "#ffd75f",
    error: "#ff5f5f",
    user: "#87afff",
    assistant: "#e4e4e4",
    tool: "#af87ff",
    border: "#585858",
    code: "#ffaf5f",
    link: "#87d7ff",
    selection: "#303030",
  },
  light: {
    text: "#1c1c1c",
    muted: "#585858",
    dim: "#8a8a8a",
    accent: "#005fd7",
    success: "#008700",
    warning: "#af5f00",
    error: "#d70000",
    user: "#005faf",
    assistant: "#1c1c1c",
    tool: "#8700af",
    border: "#bcbcbc",
    code: "#875f00",
    link: "#0087af",
    selection: "#e4e4e4",
  },
};

/**
 * 16 色下的索引（xterm 0–15）。距离取近对饱和色不可靠（`#ff5f5f` 会落到灰 8），所以内置色板查表；
 * `selection` 在 16 色下不作 bg，表里给前景兜底值。
 */
export const THEME_ANSI16: Record<ThemeName, Record<SemanticColor, number>> = {
  dark: {
    text: 7,
    muted: 7,
    dim: 8,
    accent: 12,
    success: 10,
    warning: 11,
    error: 9,
    user: 12,
    assistant: 7,
    tool: 13,
    border: 8,
    code: 11,
    link: 14,
    selection: 8,
  },
  light: {
    text: 0,
    muted: 8,
    dim: 8,
    accent: 4,
    success: 2,
    warning: 3,
    error: 1,
    user: 4,
    assistant: 0,
    tool: 5,
    border: 7,
    code: 3,
    link: 6,
    selection: 7,
  },
};

/** 阈值档位：≥ dangerAt error，≥ warnAt warning，否则 success（状态栏 ctx、Meter、/session 共用）。 */
export function levelColor(
  ratio: number,
  thresholds: { warnAt?: number; dangerAt?: number } = {},
): SemanticColor {
  if (ratio >= (thresholds.dangerAt ?? 0.9)) return "error";
  if (ratio >= (thresholds.warnAt ?? 0.7)) return "warning";
  return "success";
}

/**
 * `auto` → dark / light：不发查询序列，只看环境。`COLORFGBG` 的最后一段是背景色号（0–6、8 暗，
 * 7、9–15 亮）；没有时 Apple Terminal 按 dark；其余缺省 dark。只是猜，文档建议显式配置。
 */
export function resolveThemeName(
  name: ThemeName | "auto" | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ThemeName {
  if (name === "dark" || name === "light") return name;
  const colorfgbg = env["COLORFGBG"];
  if (colorfgbg !== undefined && colorfgbg !== "") {
    const bg = Number(colorfgbg.split(";").at(-1));
    if (Number.isInteger(bg) && bg >= 0 && bg <= 15) return bg === 7 || bg >= 9 ? "light" : "dark";
  }
  return "dark";
}

/** 由环境推断颜色深度。 */
export function detectColorDepth(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): ColorDepth {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return 0;
  const force = env["FORCE_COLOR"];
  if (force === "0") return 0;
  const term = (env["TERM"] ?? "").toLowerCase();
  if (term === "dumb") return 0;
  if (!isTTY && (force === undefined || force === "")) return 0;
  const colorterm = (env["COLORTERM"] ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit" || force === "3") return 16_777_216;
  if (term.includes("256color") || force === "2") return 256;
  return 16;
}

export function detectCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): ThemeCapabilities {
  return { colors: detectColorDepth(env, isTTY) };
}

export function parseHex(hex: string): Rgb {
  const h = hex.replace(/^#/, "");
  const n = Number.parseInt(h.length === 3 ? [...h].map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function nearestIndex(levels: readonly number[], v: number): number {
  let best = 0;
  for (let i = 1; i < levels.length; i++) {
    if (Math.abs(levels[i]! - v) < Math.abs(levels[best]! - v)) best = i;
  }
  return best;
}

function distance(a: Rgb, b: Rgb): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
}

/** RGB → xterm 256 色索引（立方与灰阶取较近者）。 */
export function rgbTo256(rgb: Rgb): number {
  const ri = nearestIndex(CUBE_LEVELS, rgb[0]);
  const gi = nearestIndex(CUBE_LEVELS, rgb[1]);
  const bi = nearestIndex(CUBE_LEVELS, rgb[2]);
  const cube: Rgb = [CUBE_LEVELS[ri]!, CUBE_LEVELS[gi]!, CUBE_LEVELS[bi]!];
  const avg = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3);
  const grayIndex = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const grayLevel = 8 + grayIndex * 10;
  const gray: Rgb = [grayLevel, grayLevel, grayLevel];
  return distance(rgb, gray) < distance(rgb, cube) ? 232 + grayIndex : 16 + 36 * ri + 6 * gi + bi;
}

/** xterm 缺省 16 色调色板。 */
const ANSI16: readonly Rgb[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

/** RGB → 16 色索引（0–15）。 */
export function rgbTo16(rgb: Rgb): number {
  let best = 0;
  for (let i = 1; i < ANSI16.length; i++) {
    if (distance(rgb, ANSI16[i]!) < distance(rgb, ANSI16[best]!)) best = i;
  }
  return best;
}

/**
 * 生成前景 / 背景开启序列；depth 0 返回空串。`ansi16` 给定时 16 色下直接用它（内置色板查表）。
 */
export function colorCode(
  hex: string,
  depth: ColorDepth,
  background: boolean,
  ansi16?: number,
): string {
  if (depth === 0) return "";
  const rgb = parseHex(hex);
  if (depth === 16_777_216) return `\x1b[${background ? 48 : 38};2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (depth === 256) return `\x1b[${background ? 48 : 38};5;${rgbTo256(rgb)}m`;
  const idx = ansi16 ?? rgbTo16(rgb);
  const base = idx < 8 ? (background ? 40 : 30) + idx : (background ? 100 : 90) + idx - 8;
  return `\x1b[${base}m`;
}

class PaletteTheme implements Theme {
  private readonly fgCodes: Record<SemanticColor, string>;
  private readonly bgCodes: Record<SemanticColor, string>;

  constructor(
    readonly name: string,
    palette: Record<SemanticColor, string>,
    readonly caps: ThemeCapabilities,
    readonly glyphs: Glyphs,
    ansi16: Partial<Record<SemanticColor, number>> = {},
  ) {
    const fg = {} as Record<SemanticColor, string>;
    const bg = {} as Record<SemanticColor, string>;
    for (const key of Object.keys(palette) as SemanticColor[]) {
      fg[key] = colorCode(palette[key], caps.colors, false, ansi16[key]);
      bg[key] = colorCode(palette[key], caps.colors, true, ansi16[key]);
    }
    this.fgCodes = fg;
    this.bgCodes = bg;
  }

  fg(color: SemanticColor, text: string): string {
    const code = this.fgCodes[color];
    return code === "" ? text : `${code}${text}\x1b[39m`;
  }

  bg(color: SemanticColor, text: string): string {
    if (color === "selection" && this.caps.colors < 256) return this.bold(this.fg("accent", text));
    const code = this.bgCodes[color];
    return code === "" ? text : `${code}${text}\x1b[49m`;
  }

  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  }

  dim(text: string): string {
    return this.caps.colors === 0 ? text : `\x1b[2m${text}\x1b[22m`;
  }

  italic(text: string): string {
    return `\x1b[3m${text}\x1b[23m`;
  }

  underline(text: string): string {
    return `\x1b[4m${text}\x1b[24m`;
  }
}

export interface CreateThemeOptions {
  caps?: ThemeCapabilities;
  /** 覆盖部分语义色（`#rrggbb`）。 */
  overrides?: Partial<Record<SemanticColor, string>>;
  /** ASCII 字形；缺省按环境检测（`detectAscii`）。 */
  ascii?: boolean;
}

export function createTheme(name: ThemeName = "dark", options: CreateThemeOptions = {}): Theme {
  const overrides = options.overrides ?? {};
  const palette = { ...THEME_PALETTES[name], ...overrides };
  const ansi16: Partial<Record<SemanticColor, number>> = { ...THEME_ANSI16[name] };
  for (const key of Object.keys(overrides) as SemanticColor[]) delete ansi16[key];
  const glyphs = glyphsFor(options.ascii ?? detectAscii());
  return new PaletteTheme(name, palette, options.caps ?? detectCapabilities(), glyphs, ansi16);
}

/** 无色主题（测试、line 模式、NO_COLOR）：所有方法原样返回文本；字形缺省 Unicode。 */
export function plainTheme(options: { ascii?: boolean } = {}): Theme {
  return new PlainTheme(glyphsFor(options.ascii === true));
}

class PlainTheme implements Theme {
  readonly name = "plain";
  readonly caps: ThemeCapabilities = { colors: 0 };
  constructor(readonly glyphs: Glyphs) {}
  fg(_color: SemanticColor, text: string): string {
    return text;
  }
  bg(_color: SemanticColor, text: string): string {
    return text;
  }
  bold(text: string): string {
    return text;
  }
  dim(text: string): string {
    return text;
  }
  italic(text: string): string {
    return text;
  }
  underline(text: string): string {
    return text;
  }
}
