/**
 * TUI 主类（设计 §12.1、§12.2，主屏 regular 模式）。[B4]
 *
 * 组件树（自身是纵向 Container）+ 焦点 + 覆盖层 + 差分渲染：
 * 1. `requestRender()` 合并到 `process.nextTick`，两帧最小间隔 16 ms；键盘输入触发的渲染绕过节流。
 * 2. 渲染组件树 → 合成覆盖层 → 提取并剔除 CURSOR_MARKER → 每行截断到宽度、含样式的行尾补重置。
 * 3. 首帧全量；宽度 / 高度变化全量（回到屏幕左上清屏，只画最后一屏）。
 * 4. 否则找首末变化行只重写该区间；首变化行已滚出视口 → 从视口顶清到屏底重画视口。
 *    已滚出终端顶部的历史行不再重绘（它们在终端回滚里）。
 * 5. 每帧写入包在同步输出 `?2026h … ?2026l` 内，按 64 KiB 分块写。
 * 6. 记录硬件光标所在内容行；最后把硬件光标移到获焦组件的光标处（便于输入法候选窗）。
 * 7. `stop()`：光标移到内容末尾下一行、显示光标、交还终端（关括号粘贴、cooked 模式）；不清屏。
 *
 * 首帧前把当前行滚到屏幕顶（输出 height-1 个换行再上移），原屏内容进入回滚而不是被清掉；
 * 这样内容起点与屏幕顶对齐，相对光标移动不会越过屏幕顶部。
 */

import { CURSOR_MARKER, isFocusable, type Component } from "./component.js";
import { SGR_RESET, truncateToWidth, visibleWidth } from "./ansi.js";
import { Container } from "./components/container.js";
import { compositeOverlays, type OverlayLayer, type OverlayOptions } from "./components/overlay.js";
import { HIDE_CURSOR, SHOW_CURSOR, type Terminal } from "./terminal.js";

export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";
export const WRITE_CHUNK_SIZE = 64 * 1024;
export const MIN_RENDER_INTERVAL_MS = 16;

export interface TuiOptions {
  /** 两帧最小间隔（ms），缺省 16。 */
  minRenderIntervalMs?: number;
  /** 获焦组件有光标时是否显示硬件光标（缺省 false：只摆位置给输入法，组件自画光标）。 */
  showHardwareCursor?: boolean;
  /** 首帧前把当前行滚到屏幕顶（缺省 true）。 */
  anchorToTop?: boolean;
  now?: () => number;
}

export interface OverlayHandle {
  hide(): void;
  /** 重新把焦点交给覆盖层组件。 */
  focus(): void;
  readonly visible: boolean;
}

/** 返回 true 表示已消费，不再交给获焦组件。 */
export type InputListener = (data: string) => boolean | void;

export interface RenderStats {
  renders: number;
  fullRedraws: number;
}

interface OverlayEntry extends OverlayLayer {
  previousFocus: Component | null;
}

/** 按 64 KiB 分块写；不切开代理对。 */
class ChunkWriter {
  private buffer = "";
  constructor(private readonly terminal: Terminal) {}

  push(data: string): void {
    this.buffer += data;
    while (this.buffer.length >= WRITE_CHUNK_SIZE) {
      let end = WRITE_CHUNK_SIZE;
      const code = this.buffer.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
      this.terminal.write(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
  }

  flush(): void {
    if (this.buffer.length > 0) this.terminal.write(this.buffer);
    this.buffer = "";
  }
}

export class TUI extends Container {
  readonly stats: RenderStats = { renders: 0, fullRedraws: 0 };
  private started = false;
  private focused: Component | null = null;
  private readonly overlays: OverlayEntry[] = [];
  private readonly listeners: InputListener[] = [];
  private readonly minInterval: number;
  private readonly now: () => number;
  private tickScheduled = false;
  private renderGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderAt = Number.NEGATIVE_INFINITY;

  // 差分状态（内容行坐标）
  private prevLines: string[] | null = null;
  private prevWidth = 0;
  private prevHeight = 0;
  /** 硬件光标所在内容行。 */
  private hwRow = 0;
  /** 终端上已存在的内容行数（自上次全量起写到过的最大行 + 1）。 */
  private bufferRows = 0;
  /** 可达的最小内容行（更早的行在回滚里或从未画过）。 */
  private topLimit = 0;
  private cursorShown: boolean | null = null;

  constructor(
    readonly terminal: Terminal,
    private readonly options: TuiOptions = {},
  ) {
    super();
    this.minInterval = options.minRenderIntervalMs ?? MIN_RENDER_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  get isStarted(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.requestRender(true),
    );
    this.requestRender(true);
  }

  /** 画完最后一帧，光标移到内容末尾下一行，交还终端；不清屏。 */
  stop(): void {
    if (!this.started) return;
    this.cancelScheduled();
    this.doRender();
    this.started = false;
    const out = new ChunkWriter(this.terminal);
    if (this.prevLines !== null && this.prevLines.length > 0) {
      out.push(this.moveTo(this.prevLines.length - 1));
      out.push("\r\n");
    }
    out.push(SHOW_CURSOR);
    out.flush();
    this.terminal.stop();
  }

  getFocus(): Component | null {
    return this.focused;
  }

  setFocus(component: Component | null): void {
    if (this.focused === component) return;
    if (this.focused && isFocusable(this.focused)) this.focused.focused = false;
    this.focused = component;
    if (component && isFocusable(component)) component.focused = true;
    this.requestRender();
  }

  /** 全局输入监听（先于获焦组件）；返回取消函数。 */
  addInputListener(listener: InputListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  showOverlay(component: Component, options: OverlayOptions = {}): OverlayHandle {
    const entry: OverlayEntry = { component, options, previousFocus: this.focused };
    this.overlays.push(entry);
    this.setFocus(component);
    this.requestRender();
    const tui = this;
    return {
      hide(): void {
        const index = tui.overlays.indexOf(entry);
        if (index === -1) return;
        tui.overlays.splice(index, 1);
        if (tui.focused === component) tui.setFocus(entry.previousFocus);
        tui.requestRender();
      },
      focus(): void {
        if (tui.overlays.includes(entry)) tui.setFocus(component);
      },
      get visible(): boolean {
        return tui.overlays.includes(entry);
      },
    };
  }

  get hasOverlay(): boolean {
    return this.overlays.length > 0;
  }

  /** 原始输入：监听器 → 获焦组件 → 立即渲染（绕过节流）。 */
  handleInput(data: string): void {
    for (const listener of [...this.listeners]) {
      if (listener(data) === true) {
        this.requestRender(true);
        return;
      }
    }
    this.focused?.handleInput?.(data);
    this.requestRender(true);
  }

  /** 请求渲染；同一 tick 内合并。immediate 用于键盘输入与 resize，不受 16 ms 节流。 */
  requestRender(immediate = false): void {
    if (!this.started || this.tickScheduled) return;
    const elapsed = this.now() - this.lastRenderAt;
    if (immediate || elapsed >= this.minInterval) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.tickScheduled = true;
      const generation = ++this.renderGeneration;
      process.nextTick(() => {
        if (generation !== this.renderGeneration) return;
        this.tickScheduled = false;
        this.doRender();
      });
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.requestRender(true);
    }, this.minInterval - elapsed);
  }

  /** 同步渲染一帧（测试与需要立刻落屏的场合）。 */
  renderNow(): void {
    this.cancelScheduled();
    this.doRender();
  }

  /** 丢弃差分状态，下一帧按 resize 方式全量重画（例如外部程序写乱了屏幕）。 */
  forceFullRedraw(): void {
    if (this.prevLines !== null) this.prevWidth = -1;
    this.requestRender(true);
  }

  private cancelScheduled(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tickScheduled = false;
    this.renderGeneration++;
  }

  /** 组件树 + 覆盖层 → 规范化行与光标位置。 */
  private compose(width: number, height: number) {
    let lines = this.render(width);
    if (this.overlays.length > 0) lines = compositeOverlays(lines, this.overlays, width, height);
    let cursor: { row: number; col: number } | null = null;
    const out: string[] = new Array<string>(lines.length);
    for (let i = lines.length - 1; i >= 0; i--) {
      let line = lines[i]!;
      const at = line.indexOf(CURSOR_MARKER);
      if (at !== -1) {
        if (cursor === null) cursor = { row: i, col: visibleWidth(line.slice(0, at)) };
        line = line.split(CURSOR_MARKER).join("");
      }
      if (visibleWidth(line) > width) line = truncateToWidth(line, width, "");
      if (line.includes("\x1b") && !line.endsWith(SGR_RESET)) line += SGR_RESET;
      out[i] = line;
    }
    return { lines: out, cursor };
  }

  private viewportTop(height: number): number {
    return Math.max(this.topLimit, this.bufferRows - height);
  }

  /** 从 hwRow 移到内容行 row 的行首；越过已有行时用换行（会滚屏）。 */
  private moveTo(row: number): string {
    let seq = "";
    if (row < this.hwRow) {
      seq += `\x1b[${this.hwRow - row}A`;
    } else if (row > this.hwRow) {
      const lastExisting = Math.max(this.hwRow, this.bufferRows - 1);
      const down = Math.min(row, lastExisting) - this.hwRow;
      if (down > 0) seq += `\x1b[${down}B`;
      const extra = row - lastExisting;
      if (extra > 0) {
        seq += "\r\n".repeat(extra);
        this.bufferRows = row + 1;
      }
    }
    this.hwRow = row;
    return seq + "\r";
  }

  private doRender(): void {
    if (!this.started) return;
    const width = this.terminal.columns;
    const height = this.terminal.rows;
    const { lines, cursor } = this.compose(width, height);
    const out = new ChunkWriter(this.terminal);
    out.push(SYNC_BEGIN);
    const prev = this.prevLines;
    if (prev === null) {
      this.fullFirst(out, lines, height);
    } else if (width !== this.prevWidth || height !== this.prevHeight) {
      this.fullResize(out, lines, height);
    } else {
      this.diff(out, prev, lines, height);
    }
    this.placeCursor(out, cursor, lines.length, height);
    out.push(SYNC_END);
    out.flush();
    this.prevLines = lines;
    this.prevWidth = width;
    this.prevHeight = height;
    this.lastRenderAt = this.now();
    this.stats.renders++;
  }

  private writeRows(out: ChunkWriter, lines: readonly string[], from: number): void {
    for (let i = from; i < lines.length; i++) {
      if (i > from) out.push("\r\n");
      out.push("\x1b[2K" + lines[i]!);
    }
  }

  private fullFirst(out: ChunkWriter, lines: string[], height: number): void {
    this.stats.fullRedraws++;
    if (this.options.anchorToTop !== false && height > 1) {
      out.push("\r" + "\n".repeat(height - 1) + `\x1b[${height - 1}A`);
    }
    out.push("\r");
    this.writeRows(out, lines, 0);
    this.topLimit = 0;
    this.bufferRows = Math.max(1, lines.length);
    this.hwRow = Math.max(0, lines.length - 1);
  }

  private fullResize(out: ChunkWriter, lines: string[], height: number): void {
    this.stats.fullRedraws++;
    const start = Math.max(0, lines.length - height);
    out.push("\x1b[H\x1b[2J");
    this.writeRows(out, lines, start);
    this.topLimit = start;
    this.bufferRows = Math.max(start + 1, lines.length);
    this.hwRow = Math.max(start, lines.length - 1);
  }

  /** 首变化行在视口之上：从视口顶清到屏底，重画视口（更早的行留在回滚里）。 */
  private fullViewport(out: ChunkWriter, lines: string[], height: number): void {
    this.stats.fullRedraws++;
    const top = this.viewportTop(height);
    out.push(this.moveTo(top) + "\x1b[J");
    const start = lines.length > top ? top : Math.max(0, lines.length - height);
    // 内容缩到视口顶以上：视口顶的屏幕行改为对应 start
    this.writeRows(out, lines, start);
    this.topLimit = start;
    this.bufferRows = Math.max(start + 1, lines.length);
    this.hwRow = Math.max(start, lines.length - 1);
  }

  private diff(out: ChunkWriter, prev: string[], lines: string[], height: number): void {
    let first = -1;
    let last = -1;
    const max = Math.max(prev.length, lines.length);
    for (let i = 0; i < max; i++) {
      if ((prev[i] ?? "") !== (lines[i] ?? "") || i >= prev.length !== i >= lines.length) {
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first === -1) return;
    if (first < this.viewportTop(height)) {
      this.fullViewport(out, lines, height);
      return;
    }
    const renderEnd = Math.min(last, lines.length - 1);
    for (let i = first; i <= renderEnd; i++) out.push(this.moveTo(i) + "\x1b[2K" + lines[i]!);
    // 内容变短：清掉多出来的旧行（它们仍在屏幕上）
    for (let i = Math.max(first, lines.length); i < prev.length; i++) {
      out.push(this.moveTo(i) + "\x1b[2K");
    }
  }

  private placeCursor(
    out: ChunkWriter,
    cursor: { row: number; col: number } | null,
    total: number,
    height: number,
  ): void {
    const visible = cursor !== null && cursor.row < total && cursor.row >= this.viewportTop(height);
    if (visible) {
      out.push(this.moveTo(cursor.row) + `\x1b[${cursor.col + 1}G`);
    }
    const show = visible && this.options.showHardwareCursor === true;
    if (this.cursorShown !== show) {
      out.push(show ? SHOW_CURSOR : HIDE_CURSOR);
      this.cursorShown = show;
    }
  }
}
