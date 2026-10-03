/**
 * [S-A] `-p` 下 bash 搜索命令被拒时的一行提示（docs/search-plan.md §4.2）。
 *
 * `minimal` / `coordinator` 预设没有 grep / glob，模型常改用 `bash grep` / `rg` / `find`，在无人值守下被拒后
 * 只能猜文件名（§1.3 E3）。这里只在「被拒的 bash 命令形如搜索」且活动集缺 grep 或 glob 时提示怎么加回来；
 * 不改权限判定，也不进模型上下文。
 */

import { msg } from "../../i18n/index.js";

/** 命令位置（行首或 `;` `&` `|` `(` 之后，允许前置 `VAR=x` / `sudo`）上的搜索类程序。 */
const SEARCH_COMMAND =
  /(?:^|[;&|(`]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:sudo\s+)?(?:\S*\/)?(?:grep|egrep|fgrep|rg|ag|ack|find|fd)(?=\s|$)/;

/** 只在这两个预设下提示：`default` 本来就有 grep / glob，`codemode-only` 的脚本里可调用它们。 */
const HINT_PRESETS = new Set(["minimal", "coordinator"]);

export function isSearchCommand(command: string): boolean {
  return SEARCH_COMMAND.test(command);
}

/** 被拒的 bash 命令里有搜索类命令、预设是 minimal / coordinator、活动集缺 grep 或 glob → 提示一行；否则 undefined。 */
export function searchToolsHint(
  deniedBashCommands: readonly string[],
  preset: string,
  activeTools: readonly string[],
): string | undefined {
  if (!HINT_PRESETS.has(preset)) return undefined;
  const missing = ["grep", "glob"].filter((name) => !activeTools.includes(name));
  if (missing.length === 0) return undefined;
  if (!deniedBashCommands.some(isSearchCommand)) return undefined;
  return msg().print.print.searchToolsMissing(preset, missing);
}
