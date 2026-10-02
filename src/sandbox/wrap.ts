/**
 * 包装命令行（docs/sandbox.md「分层」）：输入命令、参数与策略 → 输出经 OS 沙箱启动的命令行。使用方自己
 * spawn（进程组、stdio、环境都不变）。
 *
 * - 可写目录取 realpath（SBPL 按真实路径匹配，macOS 的 /tmp、/var 是符号链接；bwrap 绑定也要求存在），
 *   不存在的丢弃；
 * - `unshare` 只能隔离网络：策略要求联网时等于不包装；
 * - `none`：原样返回（调用方按 `sandboxed: false` 决定是否继续）。
 */

import { realpathSync } from "node:fs";
import type { OsSandboxStatus } from "./detect.js";
import {
  buildBwrapArgs,
  buildSbplProfile,
  buildUnshareArgs,
  type OsSandboxPolicy,
} from "./profile.js";

export interface WrappedCommand {
  command: string;
  args: string[];
  /** 实际经 OS 沙箱启动。 */
  sandboxed: boolean;
  /** 本次包装拒绝了网络。 */
  networkDenied: boolean;
  /** 本次包装把写入限制在 `writable`。 */
  writesRestricted: boolean;
}

/** 可写目录 → realpath，去掉不存在的与重复的。 */
export function resolveWritable(
  dirs: readonly string[],
  realpath: (path: string) => string = realpathSync,
): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    let real: string;
    try {
      real = realpath(dir);
    } catch {
      continue;
    }
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

export function wrapCommand(
  status: Pick<OsSandboxStatus, "kind" | "path">,
  command: string,
  args: readonly string[],
  policy: OsSandboxPolicy,
  realpath?: (path: string) => string,
): WrappedCommand {
  const plain: WrappedCommand = {
    command,
    args: [...args],
    sandboxed: false,
    networkDenied: false,
    writesRestricted: false,
  };
  if (status.kind === "none" || status.path === undefined) return plain;
  const resolved: OsSandboxPolicy = {
    network: policy.network,
    writable: resolveWritable(policy.writable, realpath),
  };
  const networkDenied = policy.network === "deny";
  switch (status.kind) {
    case "sandbox-exec":
      return {
        command: status.path,
        args: ["-p", buildSbplProfile(resolved), command, ...args],
        sandboxed: true,
        networkDenied,
        writesRestricted: true,
      };
    case "bwrap":
      return {
        command: status.path,
        args: [...buildBwrapArgs(resolved), command, ...args],
        sandboxed: true,
        networkDenied,
        writesRestricted: true,
      };
    case "unshare":
      if (!networkDenied) return plain;
      return {
        command: status.path,
        args: [...buildUnshareArgs(), command, ...args],
        sandboxed: true,
        networkDenied: true,
        writesRestricted: false,
      };
  }
}
