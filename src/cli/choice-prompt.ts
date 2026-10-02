/**
 * CLI 子命令的方向键选择（零依赖）：TTY 下 raw mode 画一个编号选项列表，原地重画。
 *
 * - 按键：↑↓（与 Ctrl+P / Ctrl+N）移动、Enter 确认、数字直选、选项按键提示里的单个字母直选（`y` / `n`），
 *   Esc / Ctrl+C / stdin 结束 = 取消；
 * - 结束后把列表收成一行「? 问题 答案」，恢复 raw 状态与光标，暂停 stdin；进程意外退出时也恢复；
 * - 颜色与字形按环境：`NO_COLOR` / 非 TTY 输出无色，`AMA_ASCII` / 区域设置决定 ASCII 字形（字形表见
 *   docs/tui-design.md §2.2）；
 * - 输入不是可开 raw 的 TTY（管道、CI）时 {@link confirmContinue} 回落为原来的文本 `[y/N]` 问答。
 */

import { createInterface } from "node:readline/promises";
import {
  createTheme,
  defaultKeybindings,
  detectCapabilities,
  padToWidth,
  resolveAscii,
  visibleWidth,
} from "../tui.js";

export interface ChoiceInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: "data" | "end", listener: (chunk?: Buffer | string) => void): unknown;
  off(event: "data" | "end", listener: (chunk?: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface ChoiceOption {
  label: string;
  /** 右侧按键提示（空格分隔）；其中的单个字母同时是直选键。 */
  keys?: string;
}

export interface PromptChoiceOptions {
  question: string;
  options: readonly ChoiceOption[];
  /** 缺省选中的下标。 */
  selected?: number;
  /** 缺省 `process.stdin`。 */
  input?: ChoiceInput;
  /** 缺省写 stderr。 */
  write?(text: string): void;
  env?: NodeJS.ProcessEnv;
  /** 输出是否 TTY（决定颜色）；缺省看 stderr。 */
  outputIsTTY?: boolean;
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** 能否用方向键选择：输入是 TTY 且能开 raw。 */
export function canPromptChoice(input: ChoiceInput = process.stdin): boolean {
  return input.isTTY === true && typeof input.setRawMode === "function";
}

/** 一块输入切成单个按键（转义序列整体、其余逐字符）。 */
export function splitKeys(data: string): string[] {
  return data.match(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[A-Za-z]|\x1b(?![[O])|[\s\S]/gu) ?? [];
}

/** 方向键选择：返回选中的下标，取消返回 undefined。调用方先用 {@link canPromptChoice} 判断。 */
export function promptChoice(options: PromptChoiceOptions): Promise<number | undefined> {
  const input = options.input ?? (process.stdin as ChoiceInput);
  const write = options.write ?? ((text: string) => void process.stderr.write(text));
  const env = options.env ?? process.env;
  const theme = createTheme("dark", {
    caps: detectCapabilities(env, options.outputIsTTY ?? process.stderr.isTTY === true),
    ascii: resolveAscii(undefined, env),
  });
  const g = theme.glyphs;
  const items = options.options;
  const n = items.length;
  let selected = Math.max(0, Math.min(n - 1, options.selected ?? 0));
  let drawn = 0;
  const keyWidth = Math.max(0, ...items.map((o) => (o.keys ?? "").length));
  const labelWidth = Math.max(...items.map((o) => visibleWidth(o.label)));
  const question = `${theme.fg("accent", "?")} ${theme.bold(options.question)}`;

  const frame = (): string[] => [
    question,
    ...items.map((item, i) => {
      const on = i === selected;
      const left = `${on ? g.prompt : " "} ${i + 1}. ${padToWidth(item.label, labelWidth)}`;
      const keys =
        item.keys === undefined ? "" : `  ${theme.fg("dim", item.keys.padEnd(keyWidth))}`;
      return (on ? theme.fg("accent", theme.bold(left)) : left) + keys;
    }),
    theme.fg("dim", `${g.arrowUp}${g.arrowDown} 选择 · Enter 确认 · 1-${n} 直接选 · Esc 取消`),
  ];
  const draw = (lines: readonly string[]): void => {
    const up = drawn > 0 ? `\x1b[${drawn}A` : "";
    write(`${up}\r\x1b[J${lines.join("\n")}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const wasRaw = input.isRaw === true;
    let done = false;
    const restore = (): void => {
      input.setRawMode?.(wasRaw);
      write(SHOW_CURSOR);
    };
    const finish = (index: number | undefined): void => {
      if (done) return;
      done = true;
      input.off("data", onData);
      input.off("end", onEnd);
      process.off("exit", restore);
      const answer = index === undefined ? "（已取消）" : items[index]!.label;
      draw([`${question} ${theme.fg("dim", answer)}`]);
      restore();
      input.pause?.();
      resolve(index);
    };
    const onKey = (key: string): void => {
      const letter = /^[a-z]$/i.test(key) ? key.toLowerCase() : "";
      const byLetter =
        letter === "" ? -1 : items.findIndex((o) => (o.keys ?? "").split(/\s+/).includes(letter));
      if (byLetter !== -1) return finish(byLetter);
      if (defaultKeybindings.matches(key, "tui.select.cancel")) return finish(undefined);
      if (/^[1-9]$/.test(key) && Number(key) <= n) return finish(Number(key) - 1);
      if (key === "\r" || key === "\n") return finish(selected);
      if (defaultKeybindings.matches(key, "tui.select.up")) selected = (selected + n - 1) % n;
      else if (defaultKeybindings.matches(key, "tui.select.down")) selected = (selected + 1) % n;
      else return;
      draw(frame());
    };
    const onData = (chunk?: Buffer | string): void => {
      for (const key of splitKeys(String(chunk ?? ""))) {
        if (done) return;
        onKey(key);
      }
    };
    const onEnd = (): void => finish(undefined);
    process.once("exit", restore);
    input.setRawMode?.(true);
    write(HIDE_CURSOR);
    draw(frame());
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume?.();
  });
}

export interface ConfirmOptions {
  /** 缺省「继续？」。 */
  question?: string;
  input?: ChoiceInput & NodeJS.ReadableStream;
  write?(text: string): void;
  /** 文本回落时问句写到哪里，缺省 stderr。 */
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  outputIsTTY?: boolean;
}

/**
 * 计费 / 写入前的确认：TTY 下方向键选择「继续 / 取消」（缺省取消，`y` / `n` 直选）；
 * 否则回落为文本 `继续？[y/N]`（只有 y / yes 算同意）。
 */
export async function confirmContinue(options: ConfirmOptions = {}): Promise<boolean> {
  const question = options.question ?? "继续？";
  const input = options.input ?? process.stdin;
  if (canPromptChoice(input)) {
    const index = await promptChoice({
      question,
      options: [
        { label: "继续", keys: "y" },
        { label: "取消", keys: "n Esc" },
      ],
      selected: 1,
      input,
      ...(options.write !== undefined ? { write: options.write } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.outputIsTTY !== undefined ? { outputIsTTY: options.outputIsTTY } : {}),
    });
    return index === 0;
  }
  const rl = createInterface({ input, output: options.output ?? process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question}[y/N] `)).trim());
  } finally {
    rl.close();
  }
}
