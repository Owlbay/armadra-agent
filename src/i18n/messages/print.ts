/**
 * 消息目录：print（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I3]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 */

import type { Messages } from "../types.js";

export const en = {};

export const zh = {} satisfies Messages<typeof en>;
