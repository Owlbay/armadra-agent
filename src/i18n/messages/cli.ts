/**
 * 消息目录：cli（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I1]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 */

import type { Messages } from "../types.js";

export const en = {
  args: {
    flagConflict: (a: string, b: string) => `${a} and ${b} cannot be used together`,
  },
  main: {
    subcommandUnavailable: (name: string) => `ama ${name}: not available in this build yet`,
  },
};

export const zh = {
  args: {
    flagConflict: (a, b) => `${a} 与 ${b} 不能同时使用`,
  },
  main: {
    subcommandUnavailable: (name) => `ama ${name}：当前版本尚未提供`,
  },
} satisfies Messages<typeof en>;
