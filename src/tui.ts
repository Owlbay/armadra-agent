/**
 * `@armadra/agent/tui` 子路径：组件库再导出（设计 D1、§12.1）。[B0] 所有。
 *
 * B0 只导出组件模型契约；B4 完成组件库后在本文件末尾追加各组件的再导出
 * （TUI、ProcessTerminal / MemoryTerminal、Container、Text、Markdown、Editor、SelectList、Box、
 * Spacer、Loader、Overlay、主题与 ansi 工具）——这是 B4 唯一允许改动的 B0 文件。
 */

export { CURSOR_MARKER, isFocusable } from "./tui/component.js";
export type * from "./tui/component.js";

// ---- B4 组件库再导出 ----
export {
  TUI,
  SYNC_BEGIN,
  SYNC_END,
  WRITE_CHUNK_SIZE,
  MIN_RENDER_INTERVAL_MS,
  type TuiOptions,
  type OverlayHandle,
  type InputListener,
  type RenderStats,
} from "./tui/tui.js";
export {
  ProcessTerminal,
  MemoryTerminal,
  BRACKETED_PASTE_ON,
  BRACKETED_PASTE_OFF,
  SHOW_CURSOR,
  HIDE_CURSOR,
  type Terminal,
  type ProcessTerminalOptions,
  type MemoryTerminalOptions,
} from "./tui/terminal.js";
export { VirtualScreen, type ScreenModes } from "./tui/vt-screen.js";
export { StdinBuffer, defaultEscTimeout, type StdinBufferOptions } from "./tui/stdin-buffer.js";
export {
  parseKey,
  matchesKey,
  normalizeKeyId,
  isPasteData,
  unwrapPaste,
  isPrintableText,
  PASTE_START,
  PASTE_END,
  type KeyEvent,
} from "./tui/keys.js";
export {
  visibleWidth,
  truncateToWidth,
  sliceByColumn,
  wrapTextWithAnsi,
  padToWidth,
  stripAnsi,
  codePointWidth,
  graphemeWidth,
  SGR_RESET,
} from "./tui/ansi.js";
export {
  createTheme,
  plainTheme,
  detectCapabilities,
  detectColorDepth,
  colorCode,
  rgbTo256,
  rgbTo16,
  THEME_PALETTES,
  THEME_ANSI16,
  resolveThemeName,
  levelColor,
  type ThemeName,
  type CreateThemeOptions,
} from "./tui/theme.js";
export {
  UNICODE_GLYPHS,
  ASCII_GLYPHS,
  detectAscii,
  resolveAscii,
  glyphsFor,
} from "./tui/glyphs.js";
export {
  Keybindings,
  defaultKeybindings,
  DEFAULT_KEYBINDINGS,
  parseKeybindings,
  loadKeybindingsFile,
  isActionId,
  type ActionId,
  type KeybindingOverrides,
  type ParsedKeybindings,
} from "./tui/keybindings.js";
export { Container } from "./tui/components/container.js";
export { Text, TruncatedText, type TextOptions } from "./tui/components/text.js";
export {
  Markdown,
  parseMarkdown,
  renderInline,
  renderBlock,
  type MarkdownOptions,
  type MarkdownBlock,
  type ListItem,
} from "./tui/components/markdown.js";
export {
  EditorBuffer,
  type Position,
  type EditorBufferOptions,
} from "./tui/components/editor-buffer.js";
export {
  Editor,
  loadHistoryFile,
  type EditorOptions,
  type AutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteResult,
  type AutocompleteContext,
} from "./tui/components/editor.js";
export {
  PasteStore,
  shouldCollapse,
  formatMarker,
  PASTE_LINE_THRESHOLD,
  PASTE_CHAR_THRESHOLD,
} from "./tui/components/editor-paste.js";
export {
  SelectList,
  filterItems,
  type SelectItem,
  type SelectListOptions,
} from "./tui/components/select-list.js";
export { Box, type BoxOptions } from "./tui/components/box.js";
export { Card, type CardOptions } from "./tui/components/card.js";
export { Spacer } from "./tui/components/spacer.js";
export {
  Loader,
  LOADER_FRAMES,
  formatElapsed,
  type LoaderOptions,
  type LoaderVerbOptions,
} from "./tui/components/loader.js";
export {
  compositeOverlays,
  type OverlayAnchor,
  type OverlayOptions,
  type OverlayLayer,
} from "./tui/components/overlay.js";
// ---- W3-B9a-2 组件 ----
export { KeyValue, type KeyValueRow, type KeyValueOptions } from "./tui/components/key-value.js";
export { Meter, METER_FULL, METER_EMPTY, type MeterOptions } from "./tui/components/meter.js";
