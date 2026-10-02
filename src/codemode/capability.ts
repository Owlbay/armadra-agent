/**
 * 沙箱能力探测（设计 §5.5 沙箱第 4 条；docs/sandbox.md「探测与降级」）。[B10][S2]
 *
 * Node 的权限模型（`--permission`）在 Node ≥ 25 同时拒绝网络；Node 22 / 24 只管文件、子进程、
 * worker 与 addon，不管网络——脚本若逃出 `vm` 就能联网。子进程另外经操作系统沙箱（macOS
 * sandbox-exec、Linux bwrap / unshare，src/sandbox）启动时，网络由内核拒绝。所以：
 * - Node ≥ 25 → `strict`（OS 沙箱可用时叠加，纵深防御）；
 * - Node 22 / 24 + 可用的 OS 沙箱 → `strict`（子进程必须经 OS 沙箱启动）；
 * - Node 22 / 24 且没有 OS 沙箱 → 仍可用，但工具描述与状态栏标注「网络未隔离」；
 *   `codemode.requireStrict: true` 时直接禁用 codemode 工具并 warning（`codemodeAvailability`）。
 *
 * 能力在进程内只探测一次（OS 沙箱探针有缓存），同一环境下描述与权限类字节稳定。状态栏直接调用
 * `detectSandboxCapability()`（不经宿主 status）；组装根先用 `configureOsSandbox` 记下 `sandbox.enabled`。
 */

import type { SandboxConfig } from "../config/types.js";
import { NO_OS_SANDBOX, osSandboxStatus, type OsSandboxStatus } from "../sandbox/detect.js";
import { msg } from "../i18n/index.js";

export interface SandboxCapability {
  /** 权限模型同时隔离文件、子进程与网络。 */
  strict: boolean;
  /** 运行时 Node 的主版本。 */
  nodeMajor: number;
  /** 人读说明（英文，进工具描述；不含完整版本号以保证同一主版本下字节稳定）。 */
  reason: string;
  /** 运行时支持的权限开关：Node ≥ 22.13 / 23.5 为 `--permission`，更早为 `--experimental-permission`。 */
  permissionFlag: "--permission" | "--experimental-permission";
  /** 操作系统沙箱（`kind: none` 表示没有）；codemode 子进程经它启动。 */
  os: OsSandboxStatus;
}

export const NETWORK_NOT_ISOLATED = "network not isolated";

export function parseNodeMajor(version: string): number {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

/** `--permission` 在 Node 22.13 / 23.5 之后才是稳定名字；之前只有 `--experimental-permission`。 */
export function permissionFlagFor(
  allowedFlags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): SandboxCapability["permissionFlag"] {
  return allowedFlags.has("--permission") ? "--permission" : "--experimental-permission";
}

/**
 * 运行时的沙箱能力。`os` 缺省：不传 `nodeVersion` 时用进程内缓存的探测结果（`osSandboxStatus()`）；
 * 传了假设的 Node 版本（测试、展示）时不探测，按没有 OS 沙箱算，需要时显式传入。
 */
export function detectSandboxCapability(
  nodeVersion?: string,
  allowedFlags?: ReadonlySet<string>,
  os?: OsSandboxStatus,
): SandboxCapability {
  const osStatus = os ?? (nodeVersion === undefined ? osSandboxStatus() : NO_OS_SANDBOX);
  const nodeMajor = parseNodeMajor(nodeVersion ?? process.versions.node);
  const permissionFlag = permissionFlagFor(allowedFlags);
  if (nodeMajor >= 25) {
    return {
      strict: true,
      nodeMajor,
      reason: `Node ${nodeMajor}: the permission model blocks file access, child processes and network`,
      permissionFlag,
      os: osStatus,
    };
  }
  if (osStatus.isolatesNetwork) {
    return {
      strict: true,
      nodeMajor,
      reason: `Node ${nodeMajor}: the OS sandbox (${osStatus.kind}) blocks network; the permission model blocks file access and child processes`,
      permissionFlag,
      os: osStatus,
    };
  }
  return {
    strict: false,
    nodeMajor,
    reason: `Node ${nodeMajor}: ${NETWORK_NOT_ISOLATED} (the permission model blocks file access and child processes only)`,
    permissionFlag,
    os: osStatus,
  };
}

/** 按配置的 `sandbox.enabled`（缺省 auto）得到运行时能力。 */
export function sandboxCapabilityFor(config: { sandbox?: SandboxConfig }): SandboxCapability {
  return detectSandboxCapability(
    undefined,
    undefined,
    osSandboxStatus(config.sandbox?.enabled ?? "auto"),
  );
}

/** strict 是否依赖 OS 沙箱（Node 22 / 24）：此时子进程必须经 OS 沙箱启动，包装不了就报错。 */
export function strictNeedsOsSandbox(capability: Pick<SandboxCapability, "strict" | "nodeMajor">) {
  return capability.strict && capability.nodeMajor < 25;
}

export type CodemodeAvailability =
  | { available: true; capability: SandboxCapability; warning?: string }
  | { available: false; capability: SandboxCapability; warning: string };

/** `requireStrict` 且运行时不是 strict → 禁用并给出 warning；非 strict 但允许 → 可用并提示。 */
export function codemodeAvailability(
  requireStrict: boolean | undefined,
  capability: SandboxCapability = detectSandboxCapability(),
): CodemodeAvailability {
  if (capability.strict) return { available: true, capability };
  if (requireStrict === true) {
    return {
      available: false,
      capability,
      warning: msg().session.codemode.disabled(capability.nodeMajor, capability.os.detail),
    };
  }
  return {
    available: true,
    capability,
    warning: msg().session.codemode.unisolated(capability.nodeMajor, capability.os.detail),
  };
}
