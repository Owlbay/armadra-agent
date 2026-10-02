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

import { isBuiltinSkill } from "../skills/builtin.js";
import { basename } from "node:path";
import { formatModelRef } from "../ai/providers/channels.js";
import type { PermissionMode } from "../permissions/types.js";
import { effectiveCodemodeMode } from "../tools/presets.js";
import { msg } from "../i18n/index.js";
import { AMA_VERSION } from "../version.js";
import type { Runtime } from "./runtime.js";

export type StartupScreenLevel = "normal" | "header" | "silent";

export function startupScreenLevel(runtime: Pick<Runtime, "config">): StartupScreenLevel {
  return runtime.config.ui?.quietStartup ?? "normal";
}

export function headerLine(): string {
  return msg().cli.startupScreen.header(AMA_VERSION);
}

function trustText(runtime: Pick<Runtime, "trust">): string {
  const { trusted, source, matchedPath } = runtime.trust;
  const label = trustSourceLabel(source);
  const from =
    source === "trust-file" && matchedPath !== undefined ? `${label} ${matchedPath}` : label;
  return msg().cli.startupScreen.trust(trusted, from);
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
  const m = msg().cli.startupScreen;
  lines.push(m.model(`${runtime.model.provider}/${runtime.model.id}`, runtime.thinkingLevel));
  lines.push(m.cwd(runtime.paths.cwd, trustText(runtime)));
  if (resources.contextFiles.length > 0) {
    lines.push(m.context(resources.contextFiles.map((f) => f.path)));
  }
  const skills = resources.skills.filter((s) => !isBuiltinSkill(s));
  if (skills.length > 0) {
    lines.push(m.skills(skills.map((s) => s.name)));
  }
  if (resources.prompts.length > 0) {
    lines.push(m.prompts(resources.prompts.map((p) => `/${p.name}`)));
  }
  const hooks = runtime.hooks.list();
  if (hooks.length > 0) lines.push(m.hooks(hooks.length));
  if (runtime.host !== undefined) lines.push(m.host(runtime.host.adapter.id));
  if (runtime.warnings.length > 0) lines.push(m.warnings(runtime.warnings.length));
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

/** 信任来源的短名（按界面语言）。 */
function trustSourceLabel(source: Runtime["trust"]["source"]): string {
  const labels = msg().cli.startupScreen.trustSource;
  return source === "trust-file" ? labels.trustFile : labels[source];
}

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
    trustSource: trustSourceLabel(runtime.trust.source),
    permissionMode: runtime.session.state.permissionMode,
    preset: runtime.config.tools?.preset ?? "default",
    codemode: effectiveCodemodeMode(runtime.config),
    contextFiles: resources.contextFiles.map((f) => basename(f.path)),
    skills: resources.skills.filter((s) => !isBuiltinSkill(s)).length,
    prompts: resources.prompts.length,
    hooks: runtime.hooks.list().length,
    warnings: runtime.warnings.length,
  };
  if (runtime.host !== undefined) info.host = runtime.host.adapter.id;
  return info;
}
