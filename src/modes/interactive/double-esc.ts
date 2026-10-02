/**
 * 空闲时的双击 Esc（rewind-plan §4）：纯状态机，键位分派里用。[RW-C]
 *
 * - 输入框为空：第一次 `arm-rewind`（提示「再按 Esc 回滚」），间隔内第二次 `rewind`（打开回滚列表）。
 * - 输入框有字：第一次 `arm-clear`（提示「再按 Esc 清空」），间隔内第二次 `clear`（清空并存进输入历史）。
 * - 两次之间输入框状态变了（空 ↔ 有字）、超过间隔、或中间按了别的键（`reset()`）都重新计。
 */

/** 两次 Esc 的最大间隔。 */
export const DOUBLE_ESC_MS = 800;
/** 第一次 Esc 的提示停留时间。 */
export const DOUBLE_ESC_HINT_MS = 1000;

export type EscAction = "arm-rewind" | "rewind" | "arm-clear" | "clear";

export class DoubleEscape {
  private armed: { kind: "rewind" | "clear"; at: number } | undefined;

  constructor(private readonly windowMs = DOUBLE_ESC_MS) {}

  press(now: number, editorEmpty: boolean): EscAction {
    const kind = editorEmpty ? "rewind" : "clear";
    const armed = this.armed;
    if (armed !== undefined && armed.kind === kind && now - armed.at <= this.windowMs) {
      this.armed = undefined;
      return kind;
    }
    this.armed = { kind, at: now };
    return kind === "rewind" ? "arm-rewind" : "arm-clear";
  }

  reset(): void {
    this.armed = undefined;
  }

  get isArmed(): boolean {
    return this.armed !== undefined;
  }
}
