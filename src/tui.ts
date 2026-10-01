/**
 * `@armadra/agent/tui` 子路径：组件库再导出（设计 D1、§12.1）。[B0] 所有。
 *
 * B0 只导出组件模型契约；B4 完成组件库后在本文件末尾追加各组件的再导出
 * （TUI、ProcessTerminal / MemoryTerminal、Container、Text、Markdown、Editor、SelectList、Box、
 * Spacer、Loader、Overlay、主题与 ansi 工具）——这是 B4 唯一允许改动的 B0 文件。
 */

export { CURSOR_MARKER, isFocusable } from "./tui/component.js";
export type * from "./tui/component.js";
