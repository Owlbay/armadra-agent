/**
 * 各驱动共用的依赖与看门狗（docs/wave5-plan.md §5.4）。[W5-E]
 */

import type { PermissionMode } from "../permissions/types.js";
import type { CatalogCandidate } from "./catalog.js";
import { candidateCapabilities } from "./catalog.js";
import type { ProgramProbe } from "./probe.js";
import { versionSatisfies } from "./probe.js";
import { spawnTransport, type AgentTransport, type SpawnTransport } from "./process.js";
import type { DriverProbe } from "./types.js";

/** 中断后等回合结束的宽限；过了关 stdin，再 SIGTERM 进程树（§5.2 cancel）。 */
export const CANCEL_GRACE_MS = 15_000;

export interface DriverDeps {
  /** 缺省起真实子进程。 */
  spawn?: SpawnTransport;
  /** 缺省：认为已安装（测试 / 宿主注入的 transport 用）。 */
  probe?: ProgramProbe;
  log?(level: "debug" | "info" | "warn", message: string): void;
  /** 缺省 {@link CANCEL_GRACE_MS}。 */
  cancelGraceMs?: number;
  /** 计时器（测试注入假时钟）。 */
  setTimer?(fn: () => void, ms: number): () => void;
}

export function defaultSetTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function spawnOf(deps: DriverDeps): SpawnTransport {
  return deps.spawn ?? ((spec) => spawnTransport(spec));
}

/** 探测一个候选：已安装、版本、静态能力；版本越过已验证区间时附 warn。 */
export async function probeCandidate(
  candidate: CatalogCandidate,
  deps: DriverDeps,
): Promise<DriverProbe & { path?: string; warning?: string }> {
  const capabilities = candidateCapabilities(candidate);
  if (deps.probe === undefined) return { installed: true, capabilities };
  const located = await deps.probe.locate(candidate.program, candidate.versionArgs);
  if (located === undefined) return { installed: false, capabilities };
  const out: DriverProbe & { path?: string; warning?: string } = {
    installed: true,
    capabilities,
    path: located.path,
  };
  if (located.version !== undefined) out.version = located.version;
  if (
    candidate.verified !== undefined &&
    located.version !== undefined &&
    !versionSatisfies(located.version, candidate.verified)
  )
    out.warning = `${candidate.program} ${located.version} 不在已验证区间 ${candidate.verified}，协议可能有变化`;
  return out;
}

/**
 * 中断的看门狗：发出协议级中断后，`graceMs` 内回合没结束就关 stdin 并杀进程树。
 * 返回取消函数（回合正常结束时调用）。
 */
export function armCancelWatchdog(
  transport: AgentTransport,
  turnDone: Promise<unknown>,
  deps: DriverDeps,
): () => void {
  const setTimer = deps.setTimer ?? defaultSetTimer;
  let fired = false;
  const clear = setTimer(() => {
    fired = true;
    deps.log?.("warn", "外部 Agent 中断后未在宽限内结束回合，关闭进程");
    void transport.terminate();
  }, deps.cancelGraceMs ?? CANCEL_GRACE_MS);
  void turnDone.finally(() => {
    if (!fired) clear();
  });
  return clear;
}

/** 模式是否只读类（plan / allowlist）：没有对应映射时不能让外部 Agent 以缺省模式跑。 */
export function isReadOnlyMode(mode: PermissionMode): boolean {
  return mode === "plan" || mode === "allowlist";
}
