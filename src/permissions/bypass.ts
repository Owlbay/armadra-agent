/**
 * 进入 Bypass permissions（`full-auto`）前的确认（docs/permissions.md「进入 Bypass」）。
 *
 * - 交互界面里的切换（Tab / Shift+Tab 循环、`/permission` 选择器、`/permission full-auto` 命令）
 *   进入 Bypass 前问一次；本次运行内确认过之后不再问；启动时已是 Bypass（命令行
 *   `--permission-mode full-auto`、配置、profile）视为已确认——那是用户的显式选择。
 * - 离开 Bypass、切到其它模式都不问。
 * - 只管「要不要问」与记住确认；怎么问（对话框 / 行式 y/N）由各界面提供 `ask`。
 */

import { msg } from "../i18n/index.js";
import type { PermissionMode } from "./types.js";

export const BYPASS_MODE: PermissionMode = "full-auto";

/** 确认框标题（随界面语言）。 */
export function bypassConfirmTitle(): string {
  return msg().permissions.bypass.title;
}

/** 确认框正文：Bypass 意味着什么（一两条关键风险）。 */
export function bypassRiskLines(): string[] {
  const m = msg().permissions.bypass;
  return [m.riskAllowAll, m.riskDangerous];
}

/** 选项：缺省选中「取消」。 */
export function bypassChoices(): { label: string; keys: string }[] {
  const m = msg().permissions.bypass;
  return [
    { label: m.choiceEnter, keys: "y" },
    { label: m.choiceCancel, keys: "n Esc" },
  ];
}
export const BYPASS_DEFAULT_CHOICE = 1;

/** 行式界面的问句（单键 y/N，缺省 N）。 */
export function bypassLineQuestion(): string {
  return msg().permissions.bypass.lineQuestion;
}

/** 不用问时同步返回 true（切换立即生效）；要问时返回等用户回答的 Promise。 */
export type BypassGate = (mode: PermissionMode) => boolean | Promise<boolean>;

/**
 * 返回「切到 `mode` 前要不要放行」的闸门：不是 Bypass 直接放行；Bypass 首次调用 `ask`，
 * 确认后本闸门内不再问。`confirmed` 为 true 表示启动时已在 Bypass（视为已确认）。
 */
export function createBypassGate(ask: () => Promise<boolean>, confirmed = false): BypassGate {
  let ok = confirmed;
  return (mode) => {
    if (mode !== BYPASS_MODE || ok) return true;
    return ask().then((answer) => (ok = answer));
  };
}
