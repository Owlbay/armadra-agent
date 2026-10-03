/**
 * 交互模式启动头（终端界面视觉设计 v1 §3.1）。
 *
 * - `normal`：无框。宽度 ≥ 72 时「AMA」字符画（startup-logo.ts）在左、信息列在右；48–71 列字符画在上、
 *   空一行、信息列在下；< 48 列退回两行简洁头（不画字符画）。`ui.logo: "off"` 或 `ui.compact` 时只画信息列，
 *   首行 `✻ ama x.y.z`。
 * - 信息列：标题（版本）、模型 · 思考、目录 · 信任（来源）、模式 · 预设 · codemode、已加载 / 宿主 / 警告
 *   （有才画）、按键提示。
 * - `header`：一行 `✻ ama x.y.z · 模型 · 模式 · /help`。`silent` 不输出（调用方不加本组件）。
 * - 着色：字符画按列 accent → user → tool 渐变；`✻` accent、标题粗体；模型 accent；已信任 success / 未信任
 *   warning；Bypass 模式 warning；按键提示与分隔点 dim。路径过长时从左截断（`…/armadra-agent`）。
 * - 启动动画通过 `setSweep` 改字符画的扫描位置（undefined = 定格），信息列不变。
 */

import { msg } from "../../i18n/index.js";
import type { StartupInfo } from "../../cli/startup-screen.js";
import { permissionModeLabel } from "../../permissions/modes.js";
import { truncateToWidth, visibleWidth, type Component, type Theme } from "../../tui.js";
import { logoRows, logoWidth, paintLogo, type SweepTarget } from "./startup-logo.js";

/** 字符画与信息列并排的最小宽度。 */
export const HEADER_SIDE_MIN_WIDTH = 72;
/** 画字符画的最小宽度；更窄时两行简洁头。 */
export const HEADER_LOGO_MIN_WIDTH = 48;
/** 字符画与信息列之间的空列。 */
const GAP = 3;

export interface StartupHeaderOptions {
  theme: Theme;
  level: "normal" | "header";
  /** `ui.compact`：不画字符画。 */
  compact?: boolean | undefined;
  /** `ui.logo`，缺省 auto；off 不画字符画。 */
  logo?: "auto" | "off" | undefined;
}

/** 从左截断到 `width` 列（保留末尾，前面加省略号）。 */
export function truncateLeft(text: string, width: number, ellipsis = "…"): string {
  if (visibleWidth(text) <= width) return text;
  const room = width - visibleWidth(ellipsis);
  if (room <= 0) return truncateToWidth(ellipsis, width);
  const chars = [...text];
  let out = "";
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = visibleWidth(chars[i]!);
    if (used + w > room) break;
    out = chars[i] + out;
    used += w;
  }
  return ellipsis + out;
}

/** 按 ` · ` 分段的提示放不下时从末尾整段去掉（至少留第一段，再不够由调用方截断）。 */
function fitSegments(text: string, width: number): string {
  const parts = text.split(" · ");
  while (parts.length > 1 && visibleWidth(parts.join(" · ")) > width) parts.pop();
  return parts.join(" · ");
}

/** 去掉模型引用里的渠道（`@messages`）。 */
function withoutChannel(model: string): string {
  const at = model.indexOf("@");
  return at === -1 ? model : model.slice(0, at);
}

export class StartupHeader implements Component, SweepTarget {
  private cache: { width: number; lines: string[] } | null = null;
  private sweep: number | undefined;

  constructor(
    private readonly info: StartupInfo,
    private readonly options: StartupHeaderOptions,
  ) {}

  private get theme(): Theme {
    return this.options.theme;
  }

  /** 这个宽度下是否画字符画（动画只在画了时播放）。 */
  hasLogo(width: number): boolean {
    return (
      this.options.level === "normal" &&
      this.options.logo !== "off" &&
      this.options.compact !== true &&
      width >= HEADER_LOGO_MIN_WIDTH
    );
  }

  setSweep(sweep: number | undefined): void {
    if (sweep === this.sweep) return;
    this.sweep = sweep;
    this.cache = null;
  }

  private title(): string {
    const t = this.theme;
    return `${t.fg("accent", t.glyphs.thinking)} ${t.bold(`ama ${this.info.version}`)}`;
  }

  private modeText(): string {
    const label = permissionModeLabel(this.info.permissionMode);
    return this.info.permissionMode === "full-auto" ? this.theme.fg("warning", label) : label;
  }

  private trustText(withSource: boolean): string {
    const { trusted, trustSource } = this.info;
    const m = msg().interactive.startup.header;
    const text = `${trusted ? m.trusted : m.untrusted}${withSource ? m.trustSource(trustSource) : ""}`;
    return this.theme.fg(trusted ? "success" : "warning", text);
  }

  private loadedText(): string | undefined {
    const { contextFiles, skills, prompts, hooks } = this.info;
    const parts: string[] = [];
    if (contextFiles.length > 0) parts.push(contextFiles.join(", "));
    if (skills > 0) parts.push(`${skills} Skill`);
    if (prompts > 0) parts.push(msg().interactive.startup.header.templates(prompts));
    if (hooks > 0) parts.push(`${hooks} Hook`);
    return parts.length === 0 ? undefined : parts.join(" · ");
  }

  private codemodeText(): string | undefined {
    return this.info.codemode === "off" ? undefined : `codemode ${this.info.codemode}`;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    let lines: string[];
    if (this.options.level === "header") lines = [this.headerLine(width)];
    else if (width < HEADER_LOGO_MIN_WIDTH) lines = this.narrowLines(width);
    else if (!this.hasLogo(width)) lines = this.infoLines(width, this.title());
    else lines = this.logoLines(width);
    this.cache = { width, lines };
    return lines;
  }

  private headerLine(width: number): string {
    const t = this.theme;
    const sep = t.fg("dim", " · ");
    const parts = [
      this.title(),
      t.fg("accent", withoutChannel(this.info.model)),
      this.modeText(),
      t.fg("dim", "/help"),
    ];
    return truncateToWidth(parts.join(sep), width);
  }

  /** < 48 列：两行（版本 · 模型 · 思考 / 模式 · 目录 · 信任），有警告再加一行。 */
  private narrowLines(width: number): string[] {
    const t = this.theme;
    const sep = t.fg("dim", " · ");
    const { info } = this;
    const lines = [
      [this.title(), t.fg("accent", withoutChannel(info.model)), info.thinking].join(sep),
    ];
    const mode = this.modeText();
    const trust = this.trustText(false);
    const room = Math.max(4, width - visibleWidth(mode) - visibleWidth(trust) - 6);
    lines.push([mode, truncateLeft(info.cwd, room, t.glyphs.ellipsis), trust].join(sep));
    if (info.warnings > 0) {
      lines.push(t.fg("warning", msg().interactive.startup.header.warnings(info.warnings)));
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  /** 信息列：首行 `title`，其后模型、目录、模式、可选行、按键提示；每行截到 `width`。 */
  private infoLines(width: number, title: string): string[] {
    const t = this.theme;
    const sep = t.fg("dim", " · ");
    const { info } = this;
    const m = msg().interactive.startup.header;
    const trust = this.trustText(true);
    const cwdRoom = Math.max(4, width - visibleWidth(trust) - 3);
    const lines = [
      title,
      t.fg("accent", info.model) + sep + m.thinking(info.thinking),
      truncateLeft(info.cwd, cwdRoom, t.glyphs.ellipsis) + sep + trust,
      [this.modeText(), m.preset(info.preset), this.codemodeText()]
        .filter((p): p is string => p !== undefined)
        .join(sep),
    ];
    const loaded = this.loadedText();
    if (loaded !== undefined) lines.push(loaded);
    if (info.host !== undefined) lines.push(m.host(info.host));
    if (info.warnings > 0) lines.push(t.fg("warning", m.warnings(info.warnings)));
    lines.push(t.fg("dim", fitSegments(m.hint, width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  /** 字符画 + 信息列：够宽并排（顶端对齐），否则上下叠放。 */
  private logoLines(width: number): string[] {
    const t = this.theme;
    const logo = paintLogo(t, this.sweep);
    const logoCols = logoWidth(logoRows(t));
    const title = `${t.bold("ama")} ${t.fg("dim", this.info.version)}`;
    if (width < HEADER_SIDE_MIN_WIDTH) {
      return [...logo, "", ...this.infoLines(width, title)];
    }
    const info = this.infoLines(width - logoCols - GAP, title);
    const rows = Math.max(logo.length, info.length);
    const blank = " ".repeat(logoCols);
    const gap = " ".repeat(GAP);
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const right = info[i];
      lines.push(right === undefined ? (logo[i] ?? "") : (logo[i] ?? blank) + gap + right);
    }
    return lines;
  }

  invalidate(): void {
    this.cache = null;
  }
}
