/**
 * 操作系统沙箱能力探测（docs/sandbox.md「探测与降级」）。
 *
 * - 「存在」不等于「可用」（嵌套在别的沙箱里、容器里没有用户命名空间）：用目标配置跑一次最小探针，退出码 0
 *   才算可用；
 * - macOS：`/usr/bin/sandbox-exec`；Linux：PATH 里的 `bwrap`，失败再试 `unshare -r -n`（只隔离网络）；
 *   其它平台：none；
 * - 开关：`sandbox.enabled: off` 或环境变量 `AMA_SANDBOX=off`；
 * - 结果在进程内缓存（按开关分两份）；`configureOsSandbox` 记下组装根读到的配置，供拿不到配置的只读调用方
 *   （状态栏）得到一致的结论。
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { posix, win32 } from "node:path";
import {
  buildBwrapArgs,
  buildSbplProfile,
  buildUnshareArgs,
  type OsSandboxKind,
  type OsSandboxPolicy,
} from "./profile.js";

export type SandboxEnabled = "auto" | "off";

export interface OsSandboxStatus {
  kind: OsSandboxKind | "none";
  /** 沙箱程序的绝对路径（kind 不是 none 时）。 */
  path?: string;
  /** 能拒绝网络。 */
  isolatesNetwork: boolean;
  /** 能把写入限制在指定目录（unshare 不能）。 */
  restrictsWrites: boolean;
  /** 人读说明（中文，给 doctor / config show）。 */
  detail: string;
}

export const NO_OS_SANDBOX: OsSandboxStatus = Object.freeze({
  kind: "none",
  isolatesNetwork: false,
  restrictsWrites: false,
  detail: "没有可用的操作系统沙箱",
});

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
export const PROBE_TIMEOUT_MS = 5000;

/** 探针用的策略：拒绝网络、不可写——与 codemode 实际使用的最严配置相同。 */
const PROBE_POLICY: OsSandboxPolicy = { network: "deny", writable: [] };

export interface ProbeDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 可执行文件存在且可执行。 */
  isExecutable(path: string): boolean;
  /** 同步运行，返回退出码（启动失败 / 超时 / 被信号杀 → null）。 */
  run(command: string, args: readonly string[]): number | null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const REAL_PROBE_DEPS: ProbeDeps = {
  platform: process.platform,
  env: process.env,
  isExecutable,
  run(command, args) {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      timeout: PROBE_TIMEOUT_MS,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    return result.error !== undefined ? null : result.status;
  },
};

/** 在 PATH 里找可执行文件（按目标平台的路径规则）。 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  check: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const path = platform === "win32" ? win32 : posix;
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    if (check(candidate)) return candidate;
  }
  return undefined;
}

/** 生效的开关：环境变量 `AMA_SANDBOX=off` 优先于配置。 */
export function resolveSandboxEnabled(
  configured: SandboxEnabled | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SandboxEnabled {
  const fromEnv = env["AMA_SANDBOX"]?.trim().toLowerCase();
  if (fromEnv === "off" || fromEnv === "0" || fromEnv === "false") return "off";
  return configured ?? "auto";
}

/** 不缓存的探测（测试注入 deps）。 */
export function probeOsSandbox(
  enabled: SandboxEnabled,
  deps: ProbeDeps = REAL_PROBE_DEPS,
): OsSandboxStatus {
  if (enabled === "off")
    return { ...NO_OS_SANDBOX, detail: "已关闭（sandbox.enabled: off 或 AMA_SANDBOX=off）" };
  if (deps.platform === "darwin") {
    if (!deps.isExecutable(SANDBOX_EXEC_PATH))
      return { ...NO_OS_SANDBOX, detail: `没有 ${SANDBOX_EXEC_PATH}` };
    const code = deps.run(SANDBOX_EXEC_PATH, [
      "-p",
      buildSbplProfile(PROBE_POLICY),
      "/usr/bin/true",
    ]);
    if (code === 0)
      return {
        kind: "sandbox-exec",
        path: SANDBOX_EXEC_PATH,
        isolatesNetwork: true,
        restrictsWrites: true,
        detail: "macOS sandbox-exec",
      };
    return {
      ...NO_OS_SANDBOX,
      detail: `sandbox-exec 探针失败（${code === null ? "无法启动" : `退出码 ${code}`}；可能已在别的沙箱里）`,
    };
  }
  if (deps.platform === "linux") {
    const failures: string[] = [];
    const bwrap = findExecutable("bwrap", deps.env, deps.isExecutable, deps.platform);
    if (bwrap !== undefined) {
      const code = deps.run(bwrap, [...buildBwrapArgs(PROBE_POLICY), "true"]);
      if (code === 0)
        return {
          kind: "bwrap",
          path: bwrap,
          isolatesNetwork: true,
          restrictsWrites: true,
          detail: "Linux bubblewrap",
        };
      failures.push(`bwrap 探针失败（${code === null ? "无法启动" : `退出码 ${code}`}）`);
    } else failures.push("没有 bwrap");
    const unshare = findExecutable("unshare", deps.env, deps.isExecutable, deps.platform);
    if (unshare !== undefined) {
      const code = deps.run(unshare, [...buildUnshareArgs(), "true"]);
      if (code === 0)
        return {
          kind: "unshare",
          path: unshare,
          isolatesNetwork: true,
          restrictsWrites: false,
          detail: `Linux unshare -r -n（只隔离网络；${failures.join("，")}）`,
        };
      failures.push(
        `unshare 探针失败（${code === null ? "无法启动" : `退出码 ${code}`}；可能不允许非特权用户命名空间）`,
      );
    } else failures.push("没有 unshare");
    return { ...NO_OS_SANDBOX, detail: failures.join("，") };
  }
  return { ...NO_OS_SANDBOX, detail: `${deps.platform} 上没有操作系统沙箱实现` };
}

const cache = new Map<SandboxEnabled, OsSandboxStatus>();
let configured: SandboxEnabled | undefined;

/** 组装根读到配置后记下（拿不到配置的只读调用方据此得到一致结论）；返回生效的状态。 */
export function configureOsSandbox(enabled: SandboxEnabled | undefined): OsSandboxStatus {
  configured = enabled;
  return osSandboxStatus(enabled);
}

/** 进程内缓存的探测结果；不传开关时用 `configureOsSandbox` 记下的配置（缺省 auto）。 */
export function osSandboxStatus(enabled: SandboxEnabled | undefined = configured): OsSandboxStatus {
  const effective = resolveSandboxEnabled(enabled);
  let status = cache.get(effective);
  if (status === undefined) {
    status = probeOsSandbox(effective);
    cache.set(effective, status);
  }
  return status;
}

/** 测试用：清空缓存与记下的配置。 */
export function resetOsSandboxForTests(): void {
  cache.clear();
  configured = undefined;
}
