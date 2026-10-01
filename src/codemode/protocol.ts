/**
 * codemode 父子进程的 JSON 行协议（设计 §5.5、实施计划 §5.1）。[B10]
 *
 * 父 → 子（子进程 stdin，一行一个 JSON）：
 * - `run`：脚本、选项、可调用工具的声明、当前 store 快照；每个子进程只收一次；
 * - `tool_result`：对某次 `tool_call` 的应答（`ok` 时带 `value`，否则带 `error` 文本）；
 * - `abort`：父进程要求结束（子进程拒绝所有未完成调用并以失败结束）。
 *
 * 子 → 父（子进程 stdout）：
 * - `tool_call`：脚本里的 `tools.<name>(input)`；
 * - `output`：`text()` / `console.log()` / `return` 产出的一段输出；
 * - `store`：脚本结束前写过的键（`null` 值 = 删除），父进程只在 `done.ok` 时提交；
 * - `done`：脚本结束（成功或失败），带用时。
 *
 * 本文件只有纯函数与类型；子进程入口（sandbox-entry.ts）不 import 它的运行时代码（子进程只被
 * 允许读自己的入口文件），只 import 类型。
 */

import { AmaError } from "../errors.js";

/** 脚本首行 `// @options: {...}` 可设的选项。 */
export interface ScriptOptions {
  /** 输出上限（估算 token，字符 / 4）；超出保留首尾，全文落盘。缺省 10 000。 */
  maxOutputTokens: number;
  /** 整个脚本的硬期限（毫秒）；到时父进程杀掉子进程树。缺省 300 000。 */
  timeoutMs: number;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
export const DEFAULT_SCRIPT_TIMEOUT_MS = 300_000;
export const MAX_SCRIPT_TIMEOUT_MS = 3_600_000;
/** 同一脚本内并发工具调用上限。 */
export const MAX_CONCURRENT_TOOL_CALLS = 8;

export const DEFAULT_SCRIPT_OPTIONS: Readonly<ScriptOptions> = Object.freeze({
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
});

/** 传给子进程的工具声明：名字 + TypeScript 声明（describeTool 返回它）。 */
export interface ToolDecl {
  name: string;
  declaration: string;
}

export type StoreSnapshot = Record<string, unknown>;

export type ParentMessage =
  | {
      type: "run";
      script: string;
      options: ScriptOptions;
      tools: ToolDecl[];
      store: StoreSnapshot;
    }
  | { type: "tool_result"; id: number; ok: true; value: unknown }
  | { type: "tool_result"; id: number; ok: false; error: string }
  | { type: "abort" };

export type ChildMessage =
  | { type: "tool_call"; id: number; name: string; input: unknown }
  | { type: "output"; text: string }
  /** 值为 null 表示删除该键。 */
  | { type: "store"; entries: Record<string, unknown> }
  | { type: "done"; ok: boolean; error?: string; elapsedMs: number };

const OPTIONS_RE = /^\s*\/\/\s*@options:\s*(.*)$/;

/**
 * 解析脚本首行的 `// @options: {...}`。没有选项行 → 缺省值；JSON 非法、键未知或取值越界 →
 * AmaError{code:"invalid_arguments"}（模型能从报错里改正）。
 */
export function parseOptionsLine(script: string): ScriptOptions {
  const firstLine = script.split("\n", 1)[0] ?? "";
  const match = OPTIONS_RE.exec(firstLine);
  const options: ScriptOptions = { ...DEFAULT_SCRIPT_OPTIONS };
  if (match === null) return options;
  let raw: unknown;
  try {
    raw = JSON.parse((match[1] ?? "").trim());
  } catch (error) {
    throw new AmaError(
      "invalid_arguments",
      `Invalid // @options line: ${(error as Error).message}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AmaError("invalid_arguments", "Invalid // @options line: expected a JSON object");
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "max_output_tokens") {
      options.maxOutputTokens = positiveInt(key, value, 1_000_000);
    } else if (key === "timeout_ms") {
      options.timeoutMs = positiveInt(key, value, MAX_SCRIPT_TIMEOUT_MS);
    } else {
      throw new AmaError(
        "invalid_arguments",
        `Invalid // @options line: unknown option "${key}" (use max_output_tokens, timeout_ms)`,
      );
    }
  }
  return options;
}

function positiveInt(key: string, value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new AmaError(
      "invalid_arguments",
      `Invalid // @options line: ${key} must be an integer between 1 and ${max}`,
    );
  }
  return value;
}

/** 编码一行（含结尾 \n）；U+2028 / U+2029 转义，保证按 \n 切行安全。 */
export function encodeLine(message: ParentMessage | ChildMessage): string {
  return `${JSON.stringify(message)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")}\n`;
}

const CHILD_TYPES = new Set(["tool_call", "output", "store", "done"]);
const PARENT_TYPES = new Set(["run", "tool_result", "abort"]);

function decode(line: string, types: ReadonlySet<string>): { type: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new AmaError("invalid_arguments", `codemode protocol: ${(error as Error).message}`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { type?: unknown }).type !== "string" ||
    !types.has((value as { type: string }).type)
  ) {
    throw new AmaError("invalid_arguments", "codemode protocol: unknown message");
  }
  return value as { type: string };
}

export function decodeChildLine(line: string): ChildMessage {
  return decode(line, CHILD_TYPES) as ChildMessage;
}

export function decodeParentLine(line: string): ParentMessage {
  return decode(line, PARENT_TYPES) as ParentMessage;
}

/** 按 \n 切行的累加器（多字节 UTF-8 由调用方 setEncoding 处理）。 */
export class LineSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim() !== "");
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() === "" ? [] : [rest];
  }
}
