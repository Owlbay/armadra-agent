/**
 * `--system-prompt <文本|@文件>` 与 `--system-prompt-mode append|replace`（W4-C）。
 *
 * - `append`（缺省）：作为最后一条规则追加进系统提示的 rules 节——preamble 与工具表在它前面，
 *   缓存前缀里最长的那段不受影响；同一段文本每次都逐字节相同。
 * - `replace`：替换开头的 preamble（「You are ama…」那一段）；工具表、规则、AGENTS.md、Skill 索引、
 *   cwd 等节照常保留，工具仍然可用。
 * - `@文件`：相对当前目录读取（UTF-8）；文件不存在或为空 → 配置错误（退出码 3，同 `--instructions`）。
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { StartupError } from "../errors.js";
import type { SystemPromptOverride } from "./deps.js";
import { ExitCode } from "./exit-codes.js";

export function resolveSystemPromptArg(
  value: string | undefined,
  mode: "append" | "replace" | undefined,
  cwd: string,
): SystemPromptOverride | undefined {
  if (value === undefined) return undefined;
  let text = value;
  if (value.startsWith("@")) {
    const raw = value.slice(1);
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
      text = readFileSync(path, "utf8");
    } catch {
      throw new StartupError(
        "config_invalid",
        `--system-prompt 文件不存在：${path}`,
        ExitCode.Config,
      );
    }
  }
  text = text.trim();
  if (text === "")
    throw new StartupError("config_invalid", "--system-prompt 的内容为空", ExitCode.Config);
  return { text, mode: mode ?? "append" };
}
