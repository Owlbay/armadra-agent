/**
 * 权限类 `memory`（docs/wave6-plan.md §3.3、D10）。[W6-C0] 管线判定；`memory` 工具本身由 W6-M 实现。
 *
 * 管线按命令把它折成已有的类再走通常的真值表：
 * - `view` → `read`：所有模式放行；
 * - 写命令（`create` / `str_replace` / `delete`，以及无法识别的命令）→ `execute`：default / auto-edit 询问
 *   （审批可选「本会话允许」）、plan 拒绝、full-auto 放行、allowlist 只放行 allow 规则命中的
 *   （`memory` 不带括号即全部放行）、auto 交给分类器。
 * 写入前的脱敏拒写、子会话写命令拒绝在工具执行层（W6-M），不在这里。
 */

import type { ToolPermission } from "../tools/types.js";

export const MEMORY_COMMANDS = ["view", "create", "str_replace", "delete"] as const;
export type MemoryCommand = (typeof MEMORY_COMMANDS)[number];

/** 调用的 `command`（不是字符串返回 undefined）。 */
export function memoryCommand(input: unknown): string | undefined {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)["command"]
      : undefined;
  return typeof raw === "string" ? raw : undefined;
}

/** `memory` 类在真值表里按哪一类判定。 */
export function memoryEffectivePermission(input: unknown): Exclude<ToolPermission, "memory"> {
  return memoryCommand(input) === "view" ? "read" : "execute";
}

/**
 * [W6-M] `memory(pattern)` 规则：pattern 是命令名（`view` / `create` / `str_replace` / `delete`）时比对命令；
 * 否则按 glob 比对逻辑路径（`/memories/user/**`，`*` 不跨 `/`，`**` 跨）；单独的 `*` / `**` 命中全部。
 * 记忆路径是逻辑路径，不按文件系统解析（`rules.ts` 对 memory 不走 bash 命令与真实路径的匹配）。
 */
export function memoryRuleMatches(pattern: string, input: unknown): boolean {
  const p = pattern.trim();
  if (p === "*" || p === "**") return true;
  if ((MEMORY_COMMANDS as readonly string[]).includes(p)) return memoryCommand(input) === p;
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)["path"]
      : undefined;
  if (typeof raw !== "string") return false;
  let body = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string;
    if (ch === "*" && p[i + 1] === "*") {
      body += ".*";
      i++;
    } else if (ch === "*") body += "[^/]*";
    else if (ch === "?") body += "[^/]";
    else body += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${body}$`).test(raw.replace(/\/+$/, ""));
}
