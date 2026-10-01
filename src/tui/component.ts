/**
 * TUI 组件模型契约（设计 §12.1、§12.7）。[B0] 契约文件，组件库实现归 B4。
 *
 * 补全与偏差：
 * - 设计的 `Theme` 写作 `bg(...)` 与 `bold/dim/italic/underline(s)`，此处展开为完整签名。
 * - `SemanticColor` 取 §12.7 的 11 个语义色名。
 * - 补全 `CURSOR_MARKER` 常量与 `isFocusable()` 判别函数（B4 的 tui.ts 与 B7 都要用）。
 */

/** APC 序列；获焦组件在光标处输出它，TUI 据此摆硬件光标并在输出前剔除。 */
export const CURSOR_MARKER = "\x1b_ama:c\x07";

export interface Component {
  /** 每行可见宽 ≤ width；每行末尾重置样式。 */
  render(width: number): string[];
  /** 焦点组件收原始键数据。 */
  handleInput?(data: string): void;
  /** 主题 / 状态变化时清缓存。 */
  invalidate(): void;
}

export interface Focusable {
  focused: boolean;
}

export function isFocusable(component: Component): component is Component & Focusable {
  return typeof (component as Partial<Focusable>).focused === "boolean";
}

export type SemanticColor =
  | "text"
  | "dim"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "user"
  | "assistant"
  | "tool"
  | "border"
  | "code";

/** 0 = 无色（NO_COLOR）；16_777_216 = truecolor。 */
export type ColorDepth = 0 | 16 | 256 | 16_777_216;

export interface ThemeCapabilities {
  colors: ColorDepth;
}

export interface Theme {
  readonly name: string;
  fg(color: SemanticColor, text: string): string;
  bg(color: SemanticColor, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  readonly caps: ThemeCapabilities;
}
