/**
 * 消息目录：cli 的参数解析错误（`src/cli/args.ts`，由 messages/cli.ts 引用为 `cli.args`）。[W6-I5]
 *
 * zh 逐字节保留迁移前的原文。选项名、取值、命令不译。
 */

import type { Messages } from "../types.js";

export const en = {
  flagConflict: (a: string, b: string) => `${a} and ${b} cannot be used together`,
  /** 两个以上：`--continue, --resume and --fork cannot be used together`。 */
  flagsConflict: (flags: readonly string[]) =>
    `${flags.length > 2 ? `${flags.slice(0, -1).join(", ")} and ${flags.at(-1)}` : flags.join(" and ")} cannot be used together`,
  invalidChoice: (option: string, choices: readonly string[], got: string) =>
    `--${option} must be one of ${choices.join(" | ")} (got ${got})`,
  emptyValue: (option: string) => `--${option} cannot be empty`,
  unknownTerminalAuth: (id: string) =>
    `--acp-terminal-auth: unknown method ${id} (expected chatgpt or api-key)`,
  fullscreenUnsupported: "--tui-mode fullscreen is not supported yet (only regular for now)",
  maxTurnsPositive: (got: string) => `--max-turns must be a positive integer (got ${got})`,
  maxCostPositive: (got: string) => `--max-cost must be a positive number (USD, got ${got})`,
  printWithMode: (mode: string) => `-p and --mode ${mode} cannot be used together`,
  apiKeyNeedsModel: "--api-key requires --model",
  printOnly: (option: string) => `${option} is only for -p / --print`,
  systemPromptModeNeedsPrompt: "--system-prompt-mode requires --system-prompt",
  noStdinWithDash: "--no-stdin and the positional argument - cannot be used together",
  dashPrintOnly: "The positional argument - (read the prompt from stdin) is only for -p / --print",
  imagePrintOnly: "--image is only for -p / --print (in the interactive UI write @image-path)",
  unknownOption: (token: string) => `Unknown option: ${token}`,
  emptyResumeId: "--resume= needs a non-empty id",
  needsValue: (option: string) => `--${option} needs a value`,
  noValue: (option: string) => `--${option} does not take a value`,
};

export const zh = {
  flagConflict: (a, b) => `${a} 与 ${b} 不能同时使用`,
  flagsConflict: (flags) => `${flags.join(" 与 ")} 不能同时使用`,
  invalidChoice: (option, choices, got) =>
    `--${option} 的取值应为 ${choices.join(" | ")}（收到 ${got}）`,
  emptyValue: (option) => `--${option} 的值不能为空`,
  unknownTerminalAuth: (id) =>
    `--acp-terminal-auth：未知的认证方法 ${id}（应为 chatgpt 或 api-key）`,
  fullscreenUnsupported: "--tui-mode fullscreen 尚未支持（第一期只有 regular）",
  maxTurnsPositive: (got) => `--max-turns 应为正整数（收到 ${got}）`,
  maxCostPositive: (got) => `--max-cost 应为正数（美元，收到 ${got}）`,
  printWithMode: (mode) => `-p 与 --mode ${mode} 不能同时使用`,
  apiKeyNeedsModel: "--api-key 需要同时给出 --model",
  printOnly: (option) => `${option} 只用于 -p / --print`,
  systemPromptModeNeedsPrompt: "--system-prompt-mode 需要同时给出 --system-prompt",
  noStdinWithDash: "--no-stdin 与位置参数 - 不能同时使用",
  dashPrintOnly: "位置参数 - （从 stdin 读提示）只用于 -p / --print",
  imagePrintOnly: "--image 只用于 -p / --print（交互界面里写 @图片路径）",
  unknownOption: (token) => `未知选项：${token}`,
  emptyResumeId: "--resume= 的 id 不能为空",
  needsValue: (option) => `--${option} 需要一个值`,
  noValue: (option) => `--${option} 不接受值`,
} satisfies Messages<typeof en>;
