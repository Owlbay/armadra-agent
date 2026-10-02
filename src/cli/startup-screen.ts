/**
 * 启动画面参数与内容（设计 §12.10）。[B5]
 *
 * 档位来源：`--quiet-startup` > 项目 / profile / 用户 config 的 `ui.quietStartup`（合并后）>
 * 有 profile 时缺省 `header` > `normal`。这里只产出纯文本行，着色与布局由界面（B7 / B6 line）负责。
 * - normal：标题行 + 模型 / 信任 / 已加载资源清单 / 警告数
 * - header：只有标题行（版本与按键提示）
 * - silent：不输出
 *
 * 交互模式（终端界面视觉设计 v1 §3.1）用结构化的 `startupInfo()` 自己排版（框 / 无框两态）；
 * `buildStartupScreen` 的纯文本行保留给 line 模式与测试。
 */

import { basename } from "node:path";
import { formatModelRef } from "../ai/providers/channels.js";
import type { PermissionMode } from "../permissions/types.js";
import { effectiveCodemodeMode } from "../tools/presets.js";
import { AMA_VERSION } from "../version.js";
import type { Runtime } from "./runtime.js";

export type StartupScreenLevel = "normal" | "header" | "silent";

export function startupScreenLevel(runtime: Pick<Runtime, "config">): StartupScreenLevel {
  return runtime.config.ui?.quietStartup ?? "normal";
}

export function headerLine(): string {
  return `ama ${AMA_VERSION} · Enter 发送 · Esc 中断 · Ctrl+C 两次退出 · /help 命令`;
}

function trustText(runtime: Pick<Runtime, "trust">): string {
  const { trusted, source, matchedPath } = runtime.trust;
  const from =
    source === "flag"
      ? "命令行"
      : source === "trust-file"
        ? `trust.json${matchedPath === undefined ? "" : ` ${matchedPath}`}`
        : source === "prompt"
          ? "本次确认"
          : source === "profile"
            ? "profile"
            : "缺省";
  return `${trusted ? "已信任" : "未信任"}（${from}）`;
}

export type StartupScreenRuntime = Pick<
  Runtime,
  | "config"
  | "trust"
  | "resources"
  | "model"
  | "thinkingLevel"
  | "hooks"
  | "host"
  | "paths"
  | "warnings"
>;

export function buildStartupScreen(
  runtime: StartupScreenRuntime,
  level: StartupScreenLevel = startupScreenLevel(runtime),
): string[] {
  if (level === "silent") return [];
  const lines = [headerLine()];
  if (level === "header") return lines;
  const { resources } = runtime;
  lines.push(`模型：${runtime.model.provider}/${runtime.model.id} · 思考 ${runtime.thinkingLevel}`);
  lines.push(`目录：${runtime.paths.cwd} · ${trustText(runtime)}`);
  if (resources.contextFiles.length > 0) {
    lines.push(`上下文：${resources.contextFiles.map((f) => f.path).join(", ")}`);
  }
  if (resources.skills.length > 0) {
    lines.push(`Skill：${resources.skills.map((s) => s.name).join(", ")}`);
  }
  if (resources.prompts.length > 0) {
    lines.push(`提示模板：${resources.prompts.map((p) => `/${p.name}`).join(" ")}`);
  }
  const hooks = runtime.hooks.list();
  if (hooks.length > 0) lines.push(`Hook：${hooks.length} 条`);
  if (runtime.host !== undefined) lines.push(`宿主：${runtime.host.adapter.id}`);
  if (runtime.warnings.length > 0)
    lines.push(`警告：${runtime.warnings.length} 条（ama doctor 查看）`);
  return lines;
}

/** 交互模式启动头的结构化字段（§3.1）。 */
export interface StartupInfo {
  version: string;
  /** `provider/id[@渠道]`。 */
  model: string;
  thinking: string;
  /** 会话目录（家目录缩写为 `~`）。 */
  cwd: string;
  trusted: boolean;
  /** 信任来源的短名（trust.json / 命令行 / 本次确认 / profile / 缺省）。 */
  trustSource: string;
  permissionMode: PermissionMode;
  preset: string;
  codemode: "off" | "on" | "only";
  /** 上下文文件的文件名（外层在前）。 */
  contextFiles: string[];
  skills: number;
  prompts: number;
  hooks: number;
  host?: string;
  warnings: number;
}

const TRUST_SOURCE: Record<Runtime["trust"]["source"], string> = {
  flag: "命令行",
  "trust-file": "trust.json",
  prompt: "本次确认",
  profile: "profile",
  default: "缺省",
};

/** 家目录前缀缩写为 `~`（`/` 与 `\` 两种分隔都认，余下部分原样保留）。 */
export function tildePath(path: string, home: string | undefined): string {
  if (home === undefined || home === "") return path;
  const trimmed = /[\\/]$/.test(home) ? home.slice(0, -1) : home;
  if (path === trimmed) return "~";
  const next = path[trimmed.length];
  return path.startsWith(trimmed) && (next === "/" || next === "\\")
    ? `~${path.slice(trimmed.length)}`
    : path;
}

export function startupInfo(
  runtime: StartupScreenRuntime & Pick<Runtime, "session">,
  home?: string,
): StartupInfo {
  const { resources } = runtime;
  const info: StartupInfo = {
    version: AMA_VERSION,
    model: formatModelRef(runtime.model),
    thinking: runtime.thinkingLevel,
    cwd: tildePath(runtime.paths.cwd, home),
    trusted: runtime.trust.trusted,
    trustSource: TRUST_SOURCE[runtime.trust.source],
    permissionMode: runtime.session.state.permissionMode,
    preset: runtime.config.tools?.preset ?? "default",
    codemode: effectiveCodemodeMode(runtime.config),
    contextFiles: resources.contextFiles.map((f) => basename(f.path)),
    skills: resources.skills.length,
    prompts: resources.prompts.length,
    hooks: runtime.hooks.list().length,
    warnings: runtime.warnings.length,
  };
  if (runtime.host !== undefined) info.host = runtime.host.adapter.id;
  return info;
}
