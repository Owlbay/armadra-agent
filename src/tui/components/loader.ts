/**
 * 旋转指示器（设计 §12.1、§12.6：运行中显示 Loader 与已用时）。[B4]
 *
 * 帧由定时器推进并调用 `requestRender`；`stop()` 后不再触发渲染。时钟可注入便于测试。
 */

import type { Component, Theme } from "../component.js";
import { truncateToWidth } from "../ansi.js";

export const LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface LoaderOptions {
  message?: string;
  theme?: Theme;
  /** 帧间隔（ms），缺省 80。 */
  intervalMs?: number;
  /** 显示已用时（`12s`、`1m05s`），缺省 true。 */
  showElapsed?: boolean;
  now?: () => number;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export class Loader implements Component {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number;
  private message: string;
  private readonly now: () => number;

  constructor(
    private readonly requestRender: () => void,
    private readonly options: LoaderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.message = options.message ?? "";
    this.startedAt = this.now();
  }

  get running(): boolean {
    return this.timer !== null;
  }

  setMessage(message: string): void {
    this.message = message;
    this.requestRender();
  }

  start(): void {
    if (this.timer !== null) return;
    this.startedAt = this.now();
    this.frame = 0;
    this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? 80);
    this.timer.unref?.();
    this.requestRender();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 推进一帧（定时器调用；测试可直接调用）。 */
  tick(): void {
    this.frame = (this.frame + 1) % LOADER_FRAMES.length;
    this.requestRender();
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const spinner = LOADER_FRAMES[this.frame]!;
    const parts = [theme ? theme.fg("accent", spinner) : spinner];
    if (this.message !== "") parts.push(this.message);
    if (this.options.showElapsed !== false) {
      const elapsed = `(${formatElapsed(this.now() - this.startedAt)})`;
      parts.push(theme ? theme.fg("dim", elapsed) : elapsed);
    }
    return [truncateToWidth(parts.join(" "), width)];
  }

  invalidate(): void {}
}
