/**
 * 操作系统沙箱的参数生成（docs/sandbox.md「各平台实现」）：纯函数，不探测、不读文件系统。
 *
 * - `buildSbplProfile`：macOS `sandbox-exec -p` 的 SBPL 配置；
 * - `buildBwrapArgs`：Linux bubblewrap 的参数（到 `--` 为止）；
 * - `buildUnshareArgs`：Linux `unshare -r -n`（只隔离网络）。
 *
 * 路径由调用方先取 realpath（wrap.ts）；这里只做转义与校验。
 */

export type OsSandboxKind = "sandbox-exec" | "bwrap" | "unshare";

export interface OsSandboxPolicy {
  /** deny：拒绝一切网络（含 Unix 域套接字与 DNS）。 */
  network: "deny" | "allow";
  /** 允许写入的目录（绝对路径，已 realpath）；其余位置一律不可写。 */
  writable: readonly string[];
  /** 可写目录里仍然只读的路径（已 realpath；bash 用：项目 `.ama/`、`.git/hooks`、`.git/config`）。 */
  readOnly?: readonly string[];
  /** 不可读的目录（已 realpath；bash 用：`~/.ssh` 等凭据目录）。 */
  hiddenDirs?: readonly string[];
  /** 不可读的文件（已 realpath；bash 用：`~/.netrc`、ama 的 `auth.json` 等）。 */
  hiddenFiles?: readonly string[];
}

/** 沙箱里始终可写的设备文件（stdio 是继承的描述符，不经路径检查）。 */
export const SBPL_DEVICE_WRITES = [
  "/dev/null",
  "/dev/zero",
  "/dev/tty",
  "/dev/dtracehelper",
] as const;

/** 含控制字符的路径不进配置（SBPL 字符串 / 命令行里都难以安全表达）。 */
export function assertSafePath(path: string): void {
  // eslint-disable-next-line no-control-regex
  if (path === "" || /[\u0000-\u001f\u007f]/.test(path))
    throw new Error(`sandbox: unsupported path ${JSON.stringify(path)}`);
}

/** SBPL 字符串字面量：转义反斜杠与双引号。 */
export function sbplString(value: string): string {
  assertSafePath(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildSbplProfile(policy: OsSandboxPolicy): string {
  const lines = ["(version 1)", "(allow default)"];
  if (policy.network === "deny") {
    lines.push("(deny network*)");
    // DNS 经 mDNSResponder：Unix 套接字已被 network* 拒绝，mach 服务也拒绝，堵住经 DNS 查询外带数据。
    lines.push('(deny mach-lookup (global-name "com.apple.dnssd.service"))');
  }
  lines.push("(deny file-write*)");
  for (const dir of policy.writable) lines.push(`(allow file-write* (subpath ${sbplString(dir)}))`);
  const devices = SBPL_DEVICE_WRITES.map((d) => `(literal ${sbplString(d)})`).join(" ");
  lines.push(`(allow file-write* ${devices} (regex #"^/dev/fd/"))`);
  // SBPL 后出现的规则优先：只读与不可读放在最后，覆盖前面的允许。
  for (const path of policy.readOnly ?? [])
    lines.push(`(deny file-write* (subpath ${sbplString(path)}))`);
  for (const path of [...(policy.hiddenDirs ?? []), ...(policy.hiddenFiles ?? [])])
    lines.push(`(deny file-read* file-write* (subpath ${sbplString(path)}))`);
  return lines.join("\n");
}

/** bwrap 参数（不含可执行文件与目标命令）：只读根 + 最小 /dev + 可写目录逐个绑回。 */
export function buildBwrapArgs(policy: OsSandboxPolicy): string[] {
  const args = ["--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev"];
  if (policy.network === "deny") args.push("--unshare-net");
  for (const dir of policy.writable) {
    assertSafePath(dir);
    args.push("--bind", dir, dir);
  }
  // 之后的挂载盖住前面的：只读路径重新只读绑定，不可读目录换成空 tmpfs、文件换成 /dev/null。
  // bwrap 只能挂到已存在的路径上，调用方只传存在的。
  for (const path of policy.readOnly ?? []) {
    assertSafePath(path);
    args.push("--ro-bind", path, path);
  }
  for (const dir of policy.hiddenDirs ?? []) {
    assertSafePath(dir);
    args.push("--tmpfs", dir);
  }
  for (const file of policy.hiddenFiles ?? []) {
    assertSafePath(file);
    args.push("--ro-bind", "/dev/null", file);
  }
  args.push("--");
  return args;
}

/** unshare 参数（不含可执行文件与目标命令）：只隔离网络，不限制写入。 */
export function buildUnshareArgs(): string[] {
  return ["-r", "-n", "--"];
}
