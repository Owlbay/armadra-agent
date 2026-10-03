/**
 * 打断并立即发送（交互模式）：运行中按 `app.message.interrupt`（缺省 `Ctrl+X`；`ui.enterWhileRunning:
 * "interrupt"` 时是 Enter）→ `prompt(text, { interrupt: true })`：取走排队的插话、中止当前回合（工具按
 * abort 收尾），以「插话… + 本条」开新回合（会话里 origin `interrupt`）。不走「中断即撤回」。
 */

import type { AgentSession } from "../../agent/types.js";
import type { ImageBlock } from "../../ai/types.js";
import type { Runtime } from "../../cli/runtime.js";
import { isAmaError } from "../../errors.js";
import { msg } from "../../i18n/index.js";
import type { Keybindings } from "../../tui.js";
import type { EnterMode } from "./run-indicator.js";
import { keyLabel } from "./task-background.js";

export interface InterruptSendDeps {
  session(): AgentSession;
  /** 取走输入框附带的图片（粘贴的剪贴板图片）。 */
  takeImages(): ImageBlock[];
  showHint(text: string): void;
}

/** 返回 `interruptSend(text)`：文字可为空（只把排队的插话立即送出）；没有可发的内容给一行提示。 */
export function interruptSender(deps: InterruptSendDeps): (text: string) => void {
  return (text) => {
    const images = deps.takeImages();
    deps.showHint(msg().interactive.keys.interruptSent);
    const options = images.length > 0 ? { interrupt: true, images } : { interrupt: true };
    void deps
      .session()
      .prompt(text, options)
      .catch((error: unknown) => {
        if (isAmaError(error) && error.code === "invalid_arguments")
          deps.showHint(msg().interactive.keys.nothingToSend);
      });
  };
}

/** `ui.enterWhileRunning`（每次按键时读，`/config` 改了立即生效）。 */
export function enterModeOf(runtime: Pick<Runtime, "config">): EnterMode {
  return runtime.config.ui?.enterWhileRunning === "interrupt" ? "interrupt" : "queue";
}

/** 专用键的标签与「立即送出排队插话」的键（interrupt 模式下是 Enter）。 */
export function interruptKeys(
  keys: Keybindings,
  mode: () => EnterMode,
): { key: string | undefined; now(): string | undefined } {
  const key = keyLabel(keys, "app.message.interrupt");
  return { key, now: () => (mode() === "interrupt" ? "Enter" : key) };
}
