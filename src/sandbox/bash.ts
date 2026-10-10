/**
 * bash 的 OS 沙箱（docs/guides/sandbox.md「第二阶段」）：配置 → 会话内固定的沙箱设定，以及每次调用的策略。
 *
 * - 生效条件：`sandbox.bash: auto` 且探测到能限制写入的沙箱（sandbox-exec / bwrap；`unshare` 只隔离网络，
 *   不算）。不生效时 bash 原样运行、权限照旧；
 * - 每次调用的策略：可写 = 会话工作区 + 系统临时目录（POSIX 另加 `/tmp`）+ ama 的输出目录 +
 *   `sandbox.writable`；工作区里 `.ama/`、`.git/hooks`、`.git/config` 仍只读（防止借 Hook / 配置 / git
 *   钩子在沙箱外执行）；凭据目录与 ama 的 `auth.json` 不可读；网络按 `sandbox.network`；
 * - 设定在组装时算一次（探测结果进程内缓存），同一会话内不变：工具描述与 schema 逐字节稳定（设计 §9.1）。
 *
 * 只依赖 `node:` 内置模块与本目录。
 */

import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { OsSandboxStatus } from "./detect.js";
import type { OsSandboxPolicy } from "./profile.js";
import { wrapCommand, type WrappedCommand } from "./wrap.js";
import { msg } from "../i18n/index.js";

export type BashSandboxMode = "auto" | "off";
export type SandboxNetwork = "deny" | "allow";

export const DEFAULT_BASH_SANDBOX_MODE: BashSandboxMode = "off";
export const DEFAULT_SANDBOX_NETWORK: SandboxNetwork = "deny";

/** 配置 `sandbox` 段里与 bash 有关的键（结构与 config/types.ts 的 SandboxConfig 相容）。 */
export interface BashSandboxConfig {
  bash?: BashSandboxMode;
  network?: SandboxNetwork;
  writable?: readonly string[];
}

export interface BashSandbox {
  /** 命令将经 OS 沙箱运行（不传 `sandbox: false` 时）。 */
  active: boolean;
  status: OsSandboxStatus;
  network: SandboxNetwork;
  /** `sandbox.writable` 展开 `~` 后的绝对路径。 */
  writable: string[];
  /** 不可读的路径（凭据目录 / 文件）。 */
  hidden: string[];
  /** 人读说明（doctor / config show）。 */
  detail: string;
}

export const NO_BASH_SANDBOX: BashSandbox = Object.freeze({
  active: false,
  status: Object.freeze({
    kind: "none",
    isolatesNetwork: false,
    restrictsWrites: false,
    get detail() {
      return msg().session.sandbox.notConfigured;
    },
  }) as OsSandboxStatus,
  network: DEFAULT_SANDBOX_NETWORK,
  writable: [],
  hidden: [],
  get detail() {
    return msg().session.sandbox.notConfigured;
  },
}) as BashSandbox;

/** 用户主目录下的凭据路径（与 permissions/protected.ts 的机密路径同一批）。 */
export const HIDDEN_HOME_PATHS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker/config.json",
  ".config/gcloud",
  ".netrc",
  ".pgpass",
  ".git-credentials",
] as const;

/** 工作区里沙箱内仍只读的路径。 */
export const WORKSPACE_READ_ONLY = [".ama", ".git/hooks", ".git/config"] as const;

/** `~` / `~/x` 展开；其余相对路径不认（返回 undefined）。 */
export function expandHome(path: string, home: string): string | undefined {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : undefined;
}

export interface ResolveBashSandboxDeps {
  status: OsSandboxStatus;
  home?: string;
  /** 额外不可读的文件（ama 的 auth.json）。 */
  hidden?: readonly string[];
}

export function resolveBashSandbox(
  config: BashSandboxConfig | undefined,
  deps: ResolveBashSandboxDeps,
): BashSandbox {
  const home = deps.home ?? homedir();
  const mode = config?.bash ?? DEFAULT_BASH_SANDBOX_MODE;
  const network = config?.network ?? DEFAULT_SANDBOX_NETWORK;
  const writable: string[] = [];
  for (const raw of config?.writable ?? []) {
    const path = expandHome(raw, home);
    if (path !== undefined && !writable.includes(path)) writable.push(path);
  }
  const hidden = [...HIDDEN_HOME_PATHS.map((p) => join(home, p)), ...(deps.hidden ?? [])];
  const status = deps.status;
  const usable = status.kind === "sandbox-exec" || status.kind === "bwrap";
  const active = mode === "auto" && usable && status.restrictsWrites;
  let detail: string;
  if (mode === "off") detail = msg().session.sandbox.bashOff;
  else if (!active)
    detail =
      status.kind === "unshare"
        ? msg().session.sandbox.bashUnshareOnly
        : msg().session.sandbox.bashUnavailable(status.detail);
  else detail = msg().session.sandbox.bashActive(status.kind, network, writable);
  return { active, status, network, writable, hidden, detail };
}

export interface BashCallPlace {
  /** 会话工作区（会话 cwd）。 */
  workspace: string;
  /** ama 的输出目录（截断全文、后台输出）。 */
  outputDir?: string;
  /** 测试注入：系统临时目录。 */
  tmpdir?: string;
  platform?: NodeJS.Platform;
}

/** 一次 bash 调用的沙箱策略（路径未 realpath，wrapCommand 再解析）。 */
export function bashSandboxPolicy(sandbox: BashSandbox, place: BashCallPlace): OsSandboxPolicy {
  const writable = [place.workspace, place.tmpdir ?? tmpdir()];
  if ((place.platform ?? process.platform) !== "win32") writable.push("/tmp");
  if (place.outputDir !== undefined) writable.push(place.outputDir);
  writable.push(...sandbox.writable);
  return {
    network: sandbox.network,
    writable,
    readOnly: WORKSPACE_READ_ONLY.map((p) => join(place.workspace, p)),
    hiddenDirs: [...sandbox.hidden],
  };
}

/** 调用参数里显式要求不经沙箱（`sandbox: false`）。 */
export function wantsUnsandboxed(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as Record<string, unknown>)["sandbox"] === false
  );
}

/** 这次调用会不会经沙箱运行（权限管线与 bash 工具共用，保证两边结论一致）。 */
export function runsSandboxed(sandbox: BashSandbox | undefined, input: unknown): boolean {
  return sandbox?.active === true && !wantsUnsandboxed(input);
}

/**
 * 包装 shell 命令行；设定生效但没能包上（不应发生）时抛错——权限管线已按「在沙箱内」放行，不能悄悄裸跑。
 */
export function wrapBashCommand(
  sandbox: BashSandbox,
  shell: string,
  args: readonly string[],
  place: BashCallPlace,
): WrappedCommand {
  const wrapped = wrapCommand(sandbox.status, shell, args, bashSandboxPolicy(sandbox, place));
  if (!wrapped.sandboxed || !wrapped.writesRestricted)
    throw new Error(`sandbox: could not wrap the command with ${sandbox.status.kind}`);
  return wrapped;
}

const WRITE_DENIAL =
  /Operation not permitted|Read-only file system|\bEPERM\b|\bEROFS\b|Permission denied|\bEACCES\b/i;
const NETWORK_DENIAL =
  /Could not resolve host|\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo|nodename nor servname|Temporary failure in name resolution|Name or service not known|Network is unreachable|\bENETUNREACH\b|Couldn't connect to server|Failed to connect|\bECONNREFUSED\b|Could not resolve hostname/i;

/** 失败输出看起来像被沙箱拒绝（写入被拒；网络拒绝时另看联网失败）。 */
export function looksLikeSandboxDenial(output: string, networkDenied: boolean): boolean {
  return WRITE_DENIAL.test(output) || (networkDenied && NETWORK_DENIAL.test(output));
}

/** 沙箱拒绝时追加给模型的一行说明。 */
export function sandboxDenialHint(networkDenied: boolean): string {
  return (
    "[sandbox: this command ran in ama's OS sandbox (writes only in the workspace and temp dirs" +
    (networkDenied ? ", no network" : "") +
    "). If it failed because of that, rerun it with sandbox:false, which needs the user's approval.]"
  );
}
