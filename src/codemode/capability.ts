/**
 * 沙箱能力探测（设计 §5.5 沙箱第 4 条）。[B10]
 *
 * Node 的权限模型（`--permission`）在 Node ≥ 25 同时拒绝网络；Node 22 / 24 只管文件、子进程、
 * worker 与 addon，不管网络——脚本若逃出 `vm` 就能联网。所以：
 * - Node ≥ 25 → `strict`；
 * - Node 22 / 24 → 仍可用，但工具描述与状态栏标注「网络未隔离」；`codemode.requireStrict: true`
 *   时直接禁用 codemode 工具并 warning（`codemodeAvailability`）。
 *
 * 状态栏由 B7 直接调用 `detectSandboxCapability()` 判断（不经宿主 status）。
 */

export interface SandboxCapability {
  /** 权限模型同时隔离文件、子进程与网络。 */
  strict: boolean;
  /** 运行时 Node 的主版本。 */
  nodeMajor: number;
  /** 人读说明（英文，进工具描述；不含完整版本号以保证同一主版本下字节稳定）。 */
  reason: string;
  /** 运行时支持的权限开关：Node ≥ 22.13 / 23.5 为 `--permission`，更早为 `--experimental-permission`。 */
  permissionFlag: "--permission" | "--experimental-permission";
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

export function detectSandboxCapability(
  nodeVersion: string = process.versions.node,
  allowedFlags?: ReadonlySet<string>,
): SandboxCapability {
  const nodeMajor = parseNodeMajor(nodeVersion);
  const permissionFlag = permissionFlagFor(allowedFlags);
  if (nodeMajor >= 25) {
    return {
      strict: true,
      nodeMajor,
      reason: `Node ${nodeMajor}: the permission model blocks file access, child processes and network`,
      permissionFlag,
    };
  }
  return {
    strict: false,
    nodeMajor,
    reason: `Node ${nodeMajor}: ${NETWORK_NOT_ISOLATED} (the permission model blocks file access and child processes only)`,
    permissionFlag,
  };
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
      warning: `codemode 已禁用：Node ${capability.nodeMajor} 的权限模型不隔离网络（codemode.requireStrict 为 true；Node ≥ 25 才隔离）`,
    };
  }
  return {
    available: true,
    capability,
    warning: `codemode：Node ${capability.nodeMajor} 下网络未隔离（Node ≥ 25 才隔离；要求隔离可设 codemode.requireStrict）`,
  };
}
