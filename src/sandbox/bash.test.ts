/** [S2] bash 沙箱设定与策略（纯函数部分；真机见 src/tools/bash-sandbox.test.ts）。 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bashSandboxPolicy,
  expandHome,
  looksLikeSandboxDenial,
  resolveBashSandbox,
  runsSandboxed,
  sandboxDenialHint,
  wrapBashCommand,
} from "./bash.js";
import type { OsSandboxStatus } from "./detect.js";
import { buildBwrapArgs, buildSbplProfile } from "./profile.js";
import { resolveExtras, wrapCommand } from "./wrap.js";

const SEATBELT: OsSandboxStatus = {
  kind: "sandbox-exec",
  path: "/usr/bin/sandbox-exec",
  isolatesNetwork: true,
  restrictsWrites: true,
  detail: "macOS sandbox-exec",
};
const BWRAP: OsSandboxStatus = { ...SEATBELT, kind: "bwrap", path: "/usr/bin/bwrap" };
const home = "/home/u";

describe("resolveBashSandbox", () => {
  it("缺省 off；auto 时只认 sandbox-exec / bwrap", () => {
    expect(resolveBashSandbox(undefined, { status: SEATBELT, home }).active).toBe(false);
    expect(resolveBashSandbox({ bash: "auto" }, { status: SEATBELT, home }).active).toBe(true);
    expect(resolveBashSandbox({ bash: "auto" }, { status: BWRAP, home }).active).toBe(true);
    const unshare = resolveBashSandbox(
      { bash: "auto" },
      { status: { ...SEATBELT, kind: "unshare", restrictsWrites: false }, home },
    );
    expect(unshare.active).toBe(false);
    expect(unshare.detail).toContain("unshare");
    const none = resolveBashSandbox(
      { bash: "auto" },
      {
        status: { kind: "none", isolatesNetwork: false, restrictsWrites: false, detail: "无" },
        home,
      },
    );
    expect(none.active).toBe(false);
    expect(none.detail).toBe("不可用：无");
  });

  it("network 缺省 deny；writable 展开 ~、丢掉相对路径；凭据路径与 auth.json 不可读", () => {
    const s = resolveBashSandbox(
      { bash: "auto", writable: ["~/.npm", "/opt/cache", "rel", "~"] },
      { status: SEATBELT, home, hidden: ["/cfg/ama/auth.json"] },
    );
    expect(s.network).toBe("deny");
    expect(s.writable).toEqual([join(home, ".npm"), resolve("/opt/cache"), home]);
    expect(s.hidden).toContain(join(home, ".ssh"));
    expect(s.hidden).toContain("/cfg/ama/auth.json");
    expect(s.detail).toContain("网络 deny");
    expect(expandHome("x/y", home)).toBeUndefined();
  });

  it("runsSandboxed：生效且没要求 sandbox:false", () => {
    const s = resolveBashSandbox({ bash: "auto" }, { status: SEATBELT, home });
    expect(runsSandboxed(s, { command: "ls" })).toBe(true);
    expect(runsSandboxed(s, { command: "ls", sandbox: true })).toBe(true);
    expect(runsSandboxed(s, { command: "ls", sandbox: false })).toBe(false);
    expect(runsSandboxed(undefined, { command: "ls" })).toBe(false);
  });
});

// Windows 上没有 OS 沙箱（bash 不包装），路径形状按 POSIX 断言
describe.skipIf(process.platform === "win32")("bashSandboxPolicy / 包装", () => {
  const s = resolveBashSandbox(
    { bash: "auto", writable: ["/opt/cache"] },
    { status: SEATBELT, home },
  );

  it("可写 = 工作区 + 临时目录 + /tmp + 输出目录 + 配置；工作区 .ama / .git 钩子与配置只读", () => {
    const p = bashSandboxPolicy(s, {
      workspace: "/w",
      outputDir: "/data/out",
      tmpdir: "/T",
      platform: "linux",
    });
    expect(p.network).toBe("deny");
    expect(p.writable).toEqual(["/w", "/T", "/tmp", "/data/out", "/opt/cache"]);
    expect(p.readOnly).toEqual([
      join("/w", ".ama"),
      join("/w", ".git/hooks"),
      join("/w", ".git/config"),
    ]);
    expect(p.hiddenDirs).toContain(join(home, ".ssh"));
  });

  it("SBPL：只读与不可读规则排在允许之后（后出现的优先）", () => {
    const text = buildSbplProfile({
      network: "deny",
      writable: ["/w"],
      readOnly: ["/w/.ama"],
      hiddenDirs: ["/h/.ssh"],
      hiddenFiles: ["/h/.netrc"],
    });
    const lines = text.split("\n");
    const allow = lines.indexOf('(allow file-write* (subpath "/w"))');
    expect(lines.indexOf('(deny file-write* (subpath "/w/.ama"))')).toBeGreaterThan(allow);
    expect(lines).toContain('(deny file-read* file-write* (subpath "/h/.ssh"))');
    expect(lines).toContain('(deny file-read* file-write* (subpath "/h/.netrc"))');
  });

  it("bwrap：只读重新绑定、目录挂 tmpfs、文件挂 /dev/null，都在可写绑定之后", () => {
    const args = buildBwrapArgs({
      network: "allow",
      writable: ["/w"],
      readOnly: ["/w/.git/hooks"],
      hiddenDirs: ["/h/.ssh"],
      hiddenFiles: ["/h/.netrc"],
    });
    expect(args).not.toContain("--unshare-net");
    const bind = args.indexOf("--bind");
    expect(args.indexOf("--ro-bind", bind)).toBeGreaterThan(bind);
    expect(args.join(" ")).toContain("--ro-bind /w/.git/hooks /w/.git/hooks");
    expect(args.join(" ")).toContain("--tmpfs /h/.ssh");
    expect(args.join(" ")).toContain("--ro-bind /dev/null /h/.netrc");
    expect(args.at(-1)).toBe("--");
  });

  it("resolveExtras：不存在的只读路径只给 SBPL（按父目录解析），不可读的按实际类型归类", () => {
    const exists = new Set(["/w", "/w/.git", "/h/.ssh", "/h/.netrc"]);
    const realpath = (p: string) => {
      if (!exists.has(p)) throw new Error("ENOENT");
      return p;
    };
    const isDir = (p: string) => p !== "/h/.netrc";
    const policy = {
      network: "deny" as const,
      writable: [],
      readOnly: ["/w/.ama", "/w/.git/hooks", "/x/missing/dir"],
      hiddenDirs: ["/h/.ssh", "/h/.netrc", "/h/.aws"],
    };
    expect(resolveExtras(policy, true, realpath, isDir)).toEqual({
      readOnly: ["/w/.ama", "/w/.git/hooks"],
      hiddenDirs: ["/h/.ssh"],
      hiddenFiles: ["/h/.netrc"],
    });
    expect(resolveExtras(policy, false, realpath, isDir).readOnly).toBeUndefined();
    const wrapped = wrapCommand(BWRAP, "/bin/sh", ["-c", "true"], policy, realpath, isDir);
    expect(wrapped.args).not.toContain("/w/.ama");
  });

  it("wrapBashCommand：包不上时抛错而不是裸跑", () => {
    const { path: _path, ...noPath } = SEATBELT;
    const broken = { ...s, status: noPath };
    expect(() => wrapBashCommand(broken, "/bin/sh", ["-c", "true"], { workspace: "/w" })).toThrow(
      /could not wrap/,
    );
    const ok = wrapBashCommand(s, "/bin/sh", ["-c", "true"], { workspace: "/" });
    expect(ok.command).toBe("/usr/bin/sandbox-exec");
    expect(ok.args.slice(-3)).toEqual(["/bin/sh", "-c", "true"]);
  });
});

describe("沙箱拒绝的提示", () => {
  it("写入被拒总算；联网失败只在 network: deny 时算", () => {
    expect(looksLikeSandboxDenial("touch: /x: Operation not permitted", false)).toBe(true);
    expect(looksLikeSandboxDenial("cannot create /x: Read-only file system", false)).toBe(true);
    expect(looksLikeSandboxDenial("curl: (6) Could not resolve host: a.b", true)).toBe(true);
    expect(looksLikeSandboxDenial("curl: (6) Could not resolve host: a.b", false)).toBe(false);
    expect(looksLikeSandboxDenial("1 test failed", true)).toBe(false);
    expect(sandboxDenialHint(true)).toContain("no network");
    expect(sandboxDenialHint(false)).not.toContain("no network");
    expect(sandboxDenialHint(true)).toContain("sandbox:false");
  });
});
