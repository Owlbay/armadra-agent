/**
 * 读配置文件 + 校验 + 诊断（设计 §11.1 第 6 / 9 / 10 步）。[B5]
 *
 * JSON 语法错误给出行列号；字段错误给出字段路径。任何 error 级诊断都抛
 * `StartupError{exitCode: 3}`（code 依文件种类为 config_invalid / profile_invalid），
 * warning 级诊断（未知字段）原样返回给调用方汇入 Runtime.warnings。
 */

import { readFileSync } from "node:fs";
import { StartupError } from "../errors.js";
import {
  type Diagnostic,
  hasErrors,
  validateAuthFile,
  validateConfig,
  validateHookConfig,
  validateProfile,
  validateTrustFile,
} from "./schema.js";
import type { AmaConfig, AuthFile, ProfileFile, TrustFile } from "./types.js";
import type { HookConfig } from "../hooks/types.js";

const EXIT_CONFIG = 3;

export type ConfigFileKind = "config" | "auth" | "profile" | "hooks" | "trust";

const VALIDATORS: Record<ConfigFileKind, (value: unknown) => Diagnostic[]> = {
  config: validateConfig,
  auth: validateAuthFile,
  profile: validateProfile,
  hooks: validateHookConfig,
  trust: validateTrustFile,
};

interface KindMap {
  config: AmaConfig;
  auth: AuthFile;
  profile: ProfileFile;
  hooks: HookConfig;
  trust: TrustFile;
}

export interface LoadedFile<T> {
  path: string;
  value: T;
  /** 已格式化的 warning（`<path>: <field>: <message>`）。 */
  warnings: string[];
}

/** 字符偏移 → 1 起的行列。 */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

/** 解析 JSON；语法错误抛带行列号的 Error。容忍 UTF-8 BOM。 */
export function parseJsonText(text: string): unknown {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lineCol = /line (\d+) column (\d+)/.exec(message);
    if (lineCol !== null)
      throw new Error(`JSON 语法错误（第 ${lineCol[1]} 行第 ${lineCol[2]} 列）：${message}`);
    const position = /position (\d+)/.exec(message);
    if (position?.[1] !== undefined) {
      const { line, column } = lineColumnAt(source, Number(position[1]));
      throw new Error(`JSON 语法错误（第 ${line} 行第 ${column} 列）：${message}`);
    }
    if (source.trim() === "") throw new Error("JSON 语法错误：文件为空");
    const end = lineColumnAt(source, source.length);
    throw new Error(`JSON 语法错误（第 ${end.line} 行第 ${end.column} 列附近）：${message}`);
  }
}

export function formatDiagnostic(path: string, d: Diagnostic): string {
  return `${path}: ${d.path === "" ? "" : `${d.path}: `}${d.message}`;
}

function failure(kind: ConfigFileKind, message: string, detail?: unknown): StartupError {
  return new StartupError(
    kind === "profile" ? "profile_invalid" : "config_invalid",
    message,
    EXIT_CONFIG,
    detail === undefined ? {} : { detail },
  );
}

export interface ReadOptions {
  /** 文件不存在时报错（缺省 false：返回 undefined）。 */
  required?: boolean;
}

/** 读并校验一个配置文件；不存在且非必需时返回 undefined。 */
export function loadConfigFile<K extends ConfigFileKind>(
  kind: K,
  path: string,
  options: ReadOptions = {},
): LoadedFile<KindMap[K]> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && options.required !== true) return undefined;
    const reason = code === "ENOENT" ? "文件不存在" : (error as Error).message;
    throw failure(kind, `${path}: ${reason}`, { path });
  }
  let value: unknown;
  try {
    value = parseJsonText(text);
  } catch (error) {
    throw failure(kind, `${path}: ${(error as Error).message}`, { path });
  }
  const diagnostics = VALIDATORS[kind](value);
  if (hasErrors(diagnostics)) {
    const lines = diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => formatDiagnostic(path, d));
    throw failure(kind, `配置文件无效：\n  ${lines.join("\n  ")}`, { path, diagnostics });
  }
  return {
    path,
    value: value as KindMap[K],
    warnings: diagnostics.map((d) => formatDiagnostic(path, d)),
  };
}

/** 读失败不抛：返回诊断（doctor 用）。 */
export function probeConfigFile(
  kind: ConfigFileKind,
  path: string,
): { exists: boolean; ok: boolean; messages: string[] } {
  try {
    const loaded = loadConfigFile(kind, path);
    if (loaded === undefined) return { exists: false, ok: true, messages: [] };
    return { exists: true, ok: true, messages: loaded.warnings };
  } catch (error) {
    return { exists: true, ok: false, messages: [(error as Error).message] };
  }
}
