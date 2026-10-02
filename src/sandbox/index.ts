/** 操作系统级沙箱（docs/sandbox.md）：探测、参数生成与命令包装。 */

export {
  NO_OS_SANDBOX,
  configureOsSandbox,
  osSandboxStatus,
  probeOsSandbox,
  resetOsSandboxForTests,
  resolveSandboxEnabled,
  type OsSandboxStatus,
  type ProbeDeps,
  type SandboxEnabled,
} from "./detect.js";
export {
  buildBwrapArgs,
  buildSbplProfile,
  buildUnshareArgs,
  type OsSandboxKind,
  type OsSandboxPolicy,
} from "./profile.js";
export { resolveWritable, wrapCommand, type WrappedCommand } from "./wrap.js";
