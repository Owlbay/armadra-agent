/**
 * 交互模式启动头（终端界面视觉设计 v1 §3.1）。
 *
 * - `normal`：宽度 ≥ 56 且非 `ui.compact` 时画框（宽 `min(width, 64)`，左对齐）——标题 `✻ ama x.y.z`、
 *   键值行（模型 / 目录 / 模式 / 已加载 / 宿主 / 警告）、按键提示；否则去框去键列，每项一行。
 * - `header`：一行 `✻ ama x.y.z · 模型 · 模式 · /help`，无框。`silent` 不输出（调用方不加本组件）。
 * - 着色：`✻` accent、标题粗体；键列 dim；模型 accent；已信任 success / 未信任 warning；Bypass 模式 warning；
 *   按键提示 dim。路径过长时从左截断（`…/armadra-agent`）。宽度变化时按新宽重算是否去框。
 */

import type { StartupInfo } from "../../cli/startup-screen.js";
import { permissionModeLabel } from "../../permissions/modes.js";
import {
  Box,
  KeyValue,
  padToWidth,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeyValueRow,
  type Theme,
} from "../../tui.js";

/** 画框的最小宽度；更窄时去框去键列。 */
export const HEADER_BOX_MIN_WIDTH = 56;
/** 设计稿写 60；常见的「供应商/模型@渠道 · 思考 级别」要 62 列左右才不截断，取 64。 */
export const HEADER_BOX_MAX_WIDTH = 64;

export interface StartupHeaderOptions {
  theme: Theme;
  level: "normal" | "header";
  /** `ui.compact`：normal 也不画框。 */
  compact?: boolean;
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

/** 去掉模型引用里的渠道（`@messages`）。 */
function withoutChannel(model: string): string {
  const at = model.indexOf("@");
  return at === -1 ? model : model.slice(0, at);
}

export class StartupHeader implements Component {
  private cache: { width: number; lines: string[] } | null = null;

  constructor(
    private readonly info: StartupInfo,
    private readonly options: StartupHeaderOptions,
  ) {}

  private get theme(): Theme {
    return this.options.theme;
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
    const text = `${trusted ? "已信任" : "未信任"}${withSource ? `（${trustSource}）` : ""}`;
    return this.theme.fg(trusted ? "success" : "warning", text);
  }

  private loadedText(): string | undefined {
    const { contextFiles, skills, prompts, hooks } = this.info;
    const parts: string[] = [];
    if (contextFiles.length > 0) parts.push(contextFiles.join(", "));
    if (skills > 0) parts.push(`${skills} Skill`);
    if (prompts > 0) parts.push(`${prompts} 模板`);
    if (hooks > 0) parts.push(`${hooks} Hook`);
    return parts.length === 0 ? undefined : parts.join(" · ");
  }

  private codemodeText(): string | undefined {
    return this.info.codemode === "off" ? undefined : `codemode ${this.info.codemode}`;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines =
      this.options.level === "header"
        ? [this.headerLine(width)]
        : this.options.compact === true || width < HEADER_BOX_MIN_WIDTH
          ? this.plainLines(width)
          : this.boxLines(width);
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

  private plainLines(width: number): string[] {
    const t = this.theme;
    const sep = t.fg("dim", " · ");
    const ellipsis = t.glyphs.ellipsis;
    const { info } = this;
    const lines = [this.title()];
    lines.push(t.fg("accent", withoutChannel(info.model)) + sep + info.thinking);
    const trust = this.trustText(false);
    const room = Math.max(4, width - visibleWidth(trust) - 3);
    lines.push(truncateLeft(info.cwd, room, ellipsis) + sep + trust);
    const mode = [this.modeText(), info.preset, this.codemodeText()].filter(
      (p): p is string => p !== undefined,
    );
    lines.push(mode.join(sep));
    const loaded = this.loadedText();
    if (loaded !== undefined) lines.push(loaded);
    if (info.host !== undefined) lines.push(`宿主 ${info.host}`);
    if (info.warnings > 0) lines.push(t.fg("warning", `警告 ${info.warnings} 条（ama doctor）`));
    lines.push(t.fg("dim", "/help · Shift+Tab 切模式"));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private boxLines(width: number): string[] {
    const t = this.theme;
    const sep = t.fg("dim", " · ");
    const { info } = this;
    const boxWidth = Math.min(width, HEADER_BOX_MAX_WIDTH);
    /** 框内文本宽：边框 2 + 内边距 2；键列 6 + 间隔 1。 */
    const valueWidth = boxWidth - 4 - 7;
    const trust = this.trustText(true);
    const cwdRoom = Math.max(4, valueWidth - visibleWidth(trust) - 3);
    const rows: KeyValueRow[] = [
      { key: "模型", value: t.fg("accent", info.model) + sep + `思考 ${info.thinking}` },
      { key: "目录", value: truncateLeft(info.cwd, cwdRoom, t.glyphs.ellipsis) + sep + trust },
      {
        key: "模式",
        value: [this.modeText(), `预设 ${info.preset}`, this.codemodeText()]
          .filter((p): p is string => p !== undefined)
          .join(sep),
      },
    ];
    const loaded = this.loadedText();
    if (loaded !== undefined) rows.push({ key: "已加载", value: loaded });
    if (info.host !== undefined) rows.push({ key: "宿主", value: info.host });
    if (info.warnings > 0) {
      rows.push({ key: "警告", value: t.fg("warning", `${info.warnings} 条（ama doctor 查看）`) });
    }
    // 键列固定 6 列（「已加载」的宽度），没有这一行时也对齐
    const padded = rows.map((row) => ({ ...row, key: padToWidth(row.key, 6) }));
    const kv = new KeyValue(padded, { theme: t, gap: 1, maxKeyRatio: 1 });
    const body: Component = {
      render: (inner) => [
        this.title(),
        "",
        ...kv.render(inner),
        "",
        t.fg("dim", "/help 命令 · Shift+Tab 切模式 · Ctrl+O 展开工具输出"),
      ],
      invalidate: () => kv.invalidate(),
    };
    return new Box(body, { theme: t }).render(boxWidth);
  }

  invalidate(): void {
    this.cache = null;
  }
}
