/**
 * shell 选择与参数拼装（设计 §5.2 bash）。[B3]
 *
 * - POSIX：`AMA_SHELL` → `/bin/bash` → `sh`；参数 `-c <command>`。
 * - Windows：`AMA_SHELL` → Git Bash 已知路径 → `powershell -NoProfile -NonInteractive -Command`；
 *   PowerShell 回退时在命令末尾追加 `$LASTEXITCODE` 透传，使 exit_code 取自它。
 * - `AMA_SHELL` 按文件名判类型：`powershell` / `pwsh` → PowerShell，`cmd` → `cmd /d /s /c`，其它按 POSIX。
 * - 工具环境：继承进程环境并注入 `AMA_SESSION_ID / AMA_SESSION_FILE / AMA_PROVIDER / AMA_MODEL /
 *   AMA_THINKING / AMA_DEPTH`（每条命令启动时取值；缺值则删掉继承来的旧值）。
 */

import { existsSync } from "node:fs";

export type ShellKind = "posix" | "powershell" | "cmd";

export interface ShellConfig {
  shell: string;
  kind: ShellKind;
}

export interface ShellDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?(path: string): boolean;
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"] as const;

export function shellKindOf(shell: string): ShellKind {
  const base = (shell.split(/[\\/]/).pop() ?? shell).toLowerCase().replace(/\.exe$/, "");
  if (base === "powershell" || base === "pwsh") return "powershell";
  if (base === "cmd") return "cmd";
  return "posix";
}

/** Windows 上 Git Bash 的已知安装位置（按优先级）。 */
export function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const add = (root: string | undefined, rest: string) => {
    if (root) out.push(`${root.replace(/[\\/]+$/, "")}\\${rest}`);
  };
  add(env["ProgramFiles"], "Git\\bin\\bash.exe");
  add(env["ProgramW6432"], "Git\\bin\\bash.exe");
  add(env["ProgramFiles(x86)"], "Git\\bin\\bash.exe");
  add(env["LOCALAPPDATA"], "Programs\\Git\\bin\\bash.exe");
  out.push("C:\\Program Files\\Git\\bin\\bash.exe");
  return [...new Set(out)];
}

export function resolveShell(deps: ShellDeps = {}): ShellConfig {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const custom = env["AMA_SHELL"]?.trim();
  if (custom) return { shell: custom, kind: shellKindOf(custom) };
  if (platform === "win32") {
    for (const candidate of gitBashCandidates(env)) {
      if (exists(candidate)) return { shell: candidate, kind: "posix" };
    }
    return { shell: "powershell.exe", kind: "powershell" };
  }
  if (exists("/bin/bash")) return { shell: "/bin/bash", kind: "posix" };
  return { shell: "sh", kind: "posix" };
}

/** PowerShell：命令后透传原生程序的 `$LASTEXITCODE`；cmdlet 失败（`$?` 为假）给 1。 */
export function wrapPowerShellCommand(command: string): string {
  return (
    `${command}\n` +
    "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 } else { exit 0 }"
  );
}

export function buildShellArgs(config: ShellConfig, command: string): string[] {
  switch (config.kind) {
    case "powershell":
      return [...POWERSHELL_ARGS, wrapPowerShellCommand(command)];
    case "cmd":
      return ["/d", "/s", "/c", command];
    default:
      return ["-c", command];
  }
}

export interface ToolEnvInput {
  sessionId: string;
  sessionFile?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
  depth: number;
}

export const INJECTED_ENV_VARS = [
  "AMA_SESSION_ID",
  "AMA_SESSION_FILE",
  "AMA_PROVIDER",
  "AMA_MODEL",
  "AMA_THINKING",
  "AMA_DEPTH",
] as const;

export function buildToolEnv(base: NodeJS.ProcessEnv, info: ToolEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of INJECTED_ENV_VARS) delete env[key];
  const set = (key: (typeof INJECTED_ENV_VARS)[number], value: string | undefined) => {
    if (value !== undefined && value !== "") env[key] = value;
  };
  set("AMA_SESSION_ID", info.sessionId);
  set("AMA_SESSION_FILE", info.sessionFile);
  set("AMA_PROVIDER", info.provider);
  set("AMA_MODEL", info.model);
  set("AMA_THINKING", info.thinkingLevel);
  set("AMA_DEPTH", String(info.depth));
  return env;
}
