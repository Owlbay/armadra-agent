/**
 * 消息目录：interactive（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I2]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  paste: {
    /** 编辑器里大粘贴的折叠标记（`tui/components/editor-paste.ts`；识别正则同时认两种语言）。 */
    marker: (id: number, lines: number) => `[paste #${id} · ${plural(lines, "line")}]`,
  },
};

export const zh = {
  paste: {
    marker: (id, lines) => `[粘贴 #${id} · ${lines} 行]`,
  },
} satisfies Messages<typeof en>;
