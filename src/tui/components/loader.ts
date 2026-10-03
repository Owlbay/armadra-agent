/**
 * 运行指示（设计 §12.1、§12.6；终端界面视觉设计 v1 §3.7）。[B4]
 *
 * 一行 `⠋ 动词 · 已用时 · 附加项…`：spinner `accent`、动词正文色、其余 `dim`，以 ` · ` 连接。
 * - `setVerb(verb, extras, { elapsed, optional })` 换动词（思考中 / 回复中 / 运行 bash / 等待确认……）；
 *   `optional` 是排在附加项之后的可丢弃项（按键提示），整行放不下时从后往前丢，而不是被截断；
 *   `setMessage(text)` 是只换动词的旧接口。
 * - 帧取 `theme.glyphs.spinner`（Unicode 10 帧 80 ms、ASCII 4 帧 250 ms）；`frame` 暴露当前帧字形，
 *   `onFrame` 让别的组件（运行中的工具摘要行）与 Loader 同帧换字，保证一帧只多改一行。
 * - `animation: false`：spinner 固定为 `glyphs.spinnerStatic`，定时器每秒一次，已用时变了才请求重绘。
 * - `stop()` 后不再触发渲染。时钟可注入便于测试。
 */

import type { Component, Theme } from "../component.js";
import { truncateToWidth, visibleWidth } from "../ansi.js";
import { UNICODE_GLYPHS } from "../glyphs.js";

/** Unicode 帧表（兼容旧导出；实际帧取 `theme.glyphs.spinner`）。 */
export const LOADER_FRAMES = UNICODE_GLYPHS.spinner;

export interface LoaderOptions {
  /** 初始动词（旧名 message）。 */
  message?: string;
  theme?: Theme;
  /** 帧间隔（ms），缺省 Unicode 80、ASCII 250；`animation: false` 时为 1000。 */
  intervalMs?: number;
  /** 显示已用时（`12s`、`1m05s`），缺省 true。 */
  showElapsed?: boolean;
  /** false：spinner 静止，缺省 true。 */
  animation?: boolean;
  now?: () => number;
}

export interface LoaderVerbOptions {
  /** 本动词是否显示已用时（缺省跟随 `showElapsed`）。 */
  elapsed?: boolean;
  /** 可丢弃的附加项：宽度不够时从后往前整项丢掉（缺省没有）。 */
  optional?: readonly string[];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((e, i) => e === b[i]);
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export class Loader implements Component {
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number;
  private verb: string;
  private extras: readonly string[] = [];
  private optional: readonly string[] = [];
  private verbElapsed: boolean | undefined;
  private lastElapsed = "";
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly now: () => number;

  constructor(
    private readonly requestRender: () => void,
    private readonly options: LoaderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.verb = options.message ?? "";
    this.startedAt = this.now();
  }

  get running(): boolean {
    return this.timer !== null;
  }

  private get frames(): readonly string[] {
    return (this.options.theme?.glyphs ?? UNICODE_GLYPHS).spinner;
  }

  private get animated(): boolean {
    return this.options.animation !== false;
  }

  /** 当前帧字形（静止时为 `spinnerStatic`）。 */
  get frame(): string {
    const glyphs = this.options.theme?.glyphs ?? UNICODE_GLYPHS;
    return this.animated
      ? this.frames[this.frameIndex % this.frames.length]!
      : glyphs.spinnerStatic;
  }

  /** 订阅换帧（返回取消函数）。 */
  onFrame(listener: (frame: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 换动词与附加项（附加项 dim，排在已用时之后）。 */
  setVerb(verb: string, extras: readonly string[] = [], options: LoaderVerbOptions = {}): void {
    const same =
      verb === this.verb &&
      options.elapsed === this.verbElapsed &&
      sameList(extras, this.extras) &&
      sameList(options.optional ?? [], this.optional);
    if (same) return;
    this.verb = verb;
    this.extras = [...extras];
    this.optional = [...(options.optional ?? [])];
    this.verbElapsed = options.elapsed;
    this.requestRender();
  }

  /** 旧接口：只换动词。 */
  setMessage(message: string): void {
    this.setVerb(message);
  }

  /** 已用时从现在重新算（换到另一段工作时）。 */
  resetElapsed(): void {
    this.startedAt = this.now();
  }

  start(): void {
    if (this.timer !== null) return;
    this.startedAt = this.now();
    this.frameIndex = 0;
    this.schedule();
    this.requestRender();
  }

  private schedule(): void {
    const glyphs = this.options.theme?.glyphs ?? UNICODE_GLYPHS;
    const interval = this.animated
      ? (this.options.intervalMs ?? (glyphs.ascii ? 250 : 80))
      : Math.max(this.options.intervalMs ?? 1000, 1000);
    this.timer = setInterval(() => this.tick(), interval);
    this.timer.unref?.();
  }

  /** [W6-S] 运行中切换动画（`/config ui.animation`）：换定时器间隔，已用时不清零。 */
  setAnimation(on: boolean): void {
    if (this.animated === on) return;
    this.options.animation = on;
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.schedule();
    this.requestRender();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 推进一帧（定时器调用；测试可直接调用）。静止时只在已用时变化时重绘。 */
  tick(): void {
    if (this.animated) this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    else if (this.elapsedText() === this.lastElapsed) return;
    const frame = this.frame;
    for (const listener of this.listeners) listener(frame);
    this.requestRender();
  }

  private elapsedText(): string {
    return formatElapsed(this.now() - this.startedAt);
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const dim = (s: string): string => (theme ? theme.fg("dim", s) : s);
    const parts: string[] = [];
    if (this.verb !== "") parts.push(this.verb);
    const elapsed = this.elapsedText();
    this.lastElapsed = elapsed;
    if (this.verbElapsed ?? this.options.showElapsed !== false) parts.push(dim(elapsed));
    for (const extra of this.extras) parts.push(dim(extra));
    const spinner = theme ? theme.fg("accent", this.frame) : this.frame;
    const line = (items: readonly string[]): string => `${spinner} ${items.join(dim(" · "))}`;
    for (const extra of this.optional) {
      const next = [...parts, dim(extra)];
      if (visibleWidth(line(next)) > width) break;
      parts.push(dim(extra));
    }
    return [truncateToWidth(line(parts), width)];
  }

  invalidate(): void {}
}
