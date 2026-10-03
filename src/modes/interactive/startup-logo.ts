/**
 * 启动头的「AMA」字符画与启动动画（终端界面视觉设计 v1 §3.1.1）。
 *
 * - 字形：缺省 5 行实心块字（`█▀▄`，宽 25）；ASCII 回退（`ui.ascii` / `AMA_ASCII=1`）用 figlet 风格的
 *   `_ / \ |`（同为 5 行、宽 25）。
 * - 着色：按列三段渐变 accent → user → tool（主题已有颜色，深浅主题 / 16 色都有对应值）；无色主题原样输出。
 * - 动画（点亮扫描）：未扫到的列 dim，扫描头 3 列 text 粗体高亮，扫过的列定格为渐变色；每帧前进 1 列，
 *   约 30 帧 × 32 ms ≈ 1 s，结束停在定格帧。动画只重画启动头所在行（差分渲染器原地改写），所以只在
 *   整屏内容装得下视口时播放；任何时候 `finish()` 立即定格。
 */

import type { SemanticColor, Theme, TUI } from "../../tui.js";

/** 缺省字形（实心块字）。 */
export const LOGO_BLOCK: readonly string[] = [
  " ▄███▄  ██▄   ▄██  ▄███▄",
  "██▀ ▀██ ███▄ ▄███ ██▀ ▀██",
  "███████ ██ ▀█▀ ██ ███████",
  "██   ██ ██     ██ ██   ██",
  "▀▀   ▀▀ ▀▀     ▀▀ ▀▀   ▀▀",
];

/** 纯 ASCII 字形（只用 `_ / \ |`）。 */
export const LOGO_ASCII: readonly string[] = [
  "    _    __  __    _",
  "   / \\  |  \\/  |  / \\",
  "  / _ \\ | |\\/| | / _ \\",
  " / ___ \\| |  | |/ ___ \\",
  "/_/   \\_\\_|  |_/_/   \\_\\",
];

/** 扫描头的宽度（列）。 */
export const SWEEP_BAND = 3;
/** 帧间隔（ms）；帧数 = 字形宽 + 扫描头宽，总时长约 1 s（上限 1.2 s）。 */
export const FRAME_MS = 32;

const GRADIENT: readonly SemanticColor[] = ["accent", "user", "tool"];
/** 每个字母起始列（渐变按字母分段，不把一个字母劈成两色）。 */
const LETTER_STARTS = { block: [0, 8, 18], ascii: [0, 8, 16] } as const;

export function logoRows(theme: Theme): readonly string[] {
  return theme.glyphs.ascii ? LOGO_ASCII : LOGO_BLOCK;
}

function letterColor(col: number, ascii: boolean): SemanticColor {
  const starts = LETTER_STARTS[ascii ? "ascii" : "block"];
  let index = 0;
  for (let i = 0; i < starts.length; i++) if (col >= starts[i]!) index = i;
  return GRADIENT[index]!;
}

/** 字形的列宽（逐字符都是 1 列）。 */
export function logoWidth(rows: readonly string[]): number {
  return Math.max(...rows.map((row) => [...row].length));
}

/** 动画总帧数（不含定格帧）。 */
export function sweepFrames(theme: Theme): number {
  return logoWidth(logoRows(theme)) + SWEEP_BAND;
}

type Style = { color: SemanticColor; bold: boolean };

/** 第 `col` 列的样式；`sweep` 为扫描头所在列，undefined 为定格。 */
function styleAt(col: number, ascii: boolean, sweep: number | undefined): Style {
  const settled: Style = { color: letterColor(col, ascii), bold: true };
  if (sweep === undefined || col <= sweep - SWEEP_BAND) return settled;
  if (col <= sweep) return { color: "text", bold: true };
  return { color: "dim", bold: false };
}

/** 画字形：同样式的连续列合成一段，空格不着色；返回的每行都补足到字形宽。 */
export function paintLogo(theme: Theme, sweep?: number): string[] {
  const rows = logoRows(theme);
  const width = logoWidth(rows);
  return rows.map((row) => {
    const chars = [...row.padEnd(width)];
    let out = "";
    let run = "";
    let runStyle: Style | undefined;
    const flush = (): void => {
      if (run === "") return;
      if (runStyle === undefined) out += run;
      else {
        const colored = theme.fg(runStyle.color, run);
        out += runStyle.bold ? theme.bold(colored) : colored;
      }
      run = "";
    };
    chars.forEach((ch, col) => {
      const style = ch === " " ? undefined : styleAt(col, theme.glyphs.ascii, sweep);
      if (style?.color !== runStyle?.color || style?.bold !== runStyle?.bold) {
        flush();
        runStyle = style;
      }
      run += ch;
    });
    flush();
    return out;
  });
}

/** 动画画到的目标（启动头）。 */
export interface SweepTarget {
  setSweep(sweep: number | undefined): void;
}

export interface LogoAnimationOptions {
  frames: number;
  intervalMs?: number;
  /** 每帧之后请求重绘。 */
  render(): void;
  /** 每帧之前检查：返回 false（内容已超出视口等）立即定格。 */
  canContinue?(): boolean;
  /** 定格之后（走完或提前结束）调用一次。 */
  onDone?(): void;
}

/** 一次性的点亮扫描：`start()` 从第 0 帧开始，走完或 `finish()` 后定格，不会再动。 */
export class LogoAnimation {
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;

  constructor(
    private readonly target: SweepTarget,
    private readonly options: LogoAnimationOptions,
  ) {}

  get running(): boolean {
    return !this.done && this.timer !== undefined;
  }

  start(): void {
    if (this.done || this.timer !== undefined) return;
    this.step();
  }

  private step(): void {
    this.timer = undefined;
    if (this.frame >= this.options.frames || this.options.canContinue?.() === false) {
      this.finish();
      return;
    }
    this.target.setSweep(this.frame++);
    this.options.render();
    this.timer = setTimeout(() => this.step(), this.options.intervalMs ?? FRAME_MS);
    this.timer.unref?.();
  }

  /** 立即定格（按键、退出、走完）；重复调用无副作用。 */
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.target.setSweep(undefined);
    this.options.render();
    this.options.onDone?.();
  }
}

/** 是否播放启动动画的输入（interactive-mode 汇总）。 */
export interface AnimationGate {
  /** `ui.animation`。 */
  animation: boolean | undefined;
  /** 启动头确实画了 logo（normal 档、`ui.logo` 非 off、非 compact、宽度够）。 */
  hasLogo: boolean;
  colors: number;
  io: { stdoutIsTTY: boolean };
  /** 嵌入宿主（profile.host）。 */
  host: boolean;
  /** 启动即提交的提示（`ama "..."`）；非空不播放。 */
  prompt: string | undefined;
  env: NodeJS.ProcessEnv;
  rows: number;
}

/** 终端低于这个行数不播放（启动头 + 输入框 + 状态栏放不下时差分渲染会把动画帧滚进回滚区）。 */
export const MIN_ANIMATION_ROWS = 16;

export function shouldAnimate(gate: AnimationGate): boolean {
  const ci = gate.env["CI"];
  return (
    gate.animation !== false &&
    gate.hasLogo &&
    gate.colors > 0 &&
    gate.io.stdoutIsTTY &&
    !gate.host &&
    (gate.prompt ?? "").trim() === "" &&
    (ci === undefined || ci === "" || ci === "0" || ci === "false") &&
    gate.rows >= MIN_ANIMATION_ROWS
  );
}

/** 能播放动画的启动头。 */
export interface AnimatedHeader extends SweepTarget {
  hasLogo(width: number): boolean;
}

/**
 * 界面启动后调用：条件满足就播放点亮扫描并返回动画（退出时 `finish()`），否则返回 undefined、启动头
 * 直接是定格帧。按任意键立即定格——监听器不吞键，按键照常进输入框。
 */
export function playStartupAnimation(
  tui: TUI,
  header: AnimatedHeader | undefined,
  theme: Theme,
  conditions: Omit<AnimationGate, "hasLogo" | "colors" | "rows">,
): LogoAnimation | undefined {
  const term = tui.terminal;
  const columns = term.columns;
  if (header === undefined) return undefined;
  const gate: AnimationGate = {
    ...conditions,
    hasLogo: header.hasLogo(term.columns),
    colors: theme.caps.colors,
    rows: term.rows,
  };
  // 整屏内容装得下视口，动画帧才只在原地改写、不进回滚区
  const fits = (): boolean => tui.render(term.columns).length <= term.rows;
  if (!shouldAnimate(gate) || !fits()) return undefined;
  let offInput = (): void => undefined;
  const animation = new LogoAnimation(header, {
    frames: sweepFrames(theme),
    render: () => tui.requestRender(),
    // 改了尺寸（差分渲染要整屏重画）也立即定格
    canContinue: () => term.columns === columns && fits(),
    onDone: () => offInput(),
  });
  offInput = tui.addInputListener(() => {
    animation.finish();
    return false;
  });
  animation.start();
  return animation;
}
