/**
 * 交互模式装配用到的两个小工具（从 interactive-mode.ts 拆出，控制单文件行数）：真实终端与 keybindings.json。
 */

import { join } from "node:path";
import type { Runtime } from "../../cli/runtime.js";
import { KEYBINDINGS_FILE } from "../../config/paths.js";
import { AmaError } from "../../errors.js";
import { msg } from "../../i18n/index.js";
import { Keybindings, ProcessTerminal, loadKeybindingsFile, type Terminal } from "../../tui.js";

/** stdin / stdout 都是 TTY 才用真实终端；否则抛 `terminal_init_failed`（调用方降级到行式界面）。 */
export function processTerminal(): Terminal {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: unknown };
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== "function" || !process.stdout.isTTY) {
    throw new AmaError("terminal_init_failed", msg().interactive.app.notTty);
  }
  return new ProcessTerminal();
}

/** 读 `<configDir>/keybindings.json`；问题逐条交给 `warn`。 */
export function loadKeys(runtime: Runtime, warn: (m: string) => void): Keybindings {
  const parsed = loadKeybindingsFile(join(runtime.paths.configDir, KEYBINDINGS_FILE));
  for (const w of parsed.warnings) warn(msg().interactive.app.keybindingsWarning(w));
  return new Keybindings(parsed.overrides);
}
