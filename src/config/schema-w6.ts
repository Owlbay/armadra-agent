/**
 * 第六波配置键的校验（docs/wave6-plan.md §7；规则与 json-schema.ts 一一对应）。[W6-C0]
 *
 * 类型 / 取值错误是 error，未知字段是 warning。只校验形状；行为由各批次实现。
 */

import type { Checker, Obj } from "./checker.js";
import { LANGUAGE_SETTINGS } from "./types-w6.js";

/** 已有 `ui` 段新增的键。 */
export const W6_UI_KEYS = ["language"] as const;

export function checkUiW6(c: Checker, ui: Obj, path: string): void {
  c.oneOf(ui, "language", path, LANGUAGE_SETTINGS);
}
