/**
 * `ama --help` 的文本（从 args.ts 搬出，args.ts 再导出）。[W5-C0]
 * [W6-I1] 文本进消息目录（`msg().cli.help`），按界面语言取；不能是模块级常量（会按 import 时的语言定死）。
 */

import { msg } from "../i18n/index.js";

export function helpText(): string {
  return msg().cli.help;
}
