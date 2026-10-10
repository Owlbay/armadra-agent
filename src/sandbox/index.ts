/** 操作系统级沙箱（docs/guides/sandbox.md）：探测、参数生成与命令包装。 */

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
export { resolveExtras, resolveWritable, wrapCommand, type WrappedCommand } from "./wrap.js";
export {
  DEFAULT_BASH_SANDBOX_MODE,
  DEFAULT_SANDBOX_NETWORK,
  NO_BASH_SANDBOX,
  bashSandboxPolicy,
  looksLikeSandboxDenial,
  resolveBashSandbox,
  runsSandboxed,
  sandboxDenialHint,
  wantsUnsandboxed,
  wrapBashCommand,
  type BashCallPlace,
  type BashSandbox,
  type BashSandboxConfig,
  type BashSandboxMode,
  type SandboxNetwork,
} from "./bash.js";
