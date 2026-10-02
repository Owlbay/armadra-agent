import { describe, expect, it } from "vitest";
import { buildBwrapArgs, buildSbplProfile, buildUnshareArgs, sbplString } from "./profile.js";
import { resolveWritable, wrapCommand } from "./wrap.js";

describe("buildSbplProfile（黄金）", () => {
  it("拒绝网络 + 可写目录", () => {
    expect(buildSbplProfile({ network: "deny", writable: ["/work", "/private/var/folders/x"] }))
      .toBe(`(version 1)
(allow default)
(deny network*)
(deny mach-lookup (global-name "com.apple.dnssd.service"))
(deny file-write*)
(allow file-write* (subpath "/work"))
(allow file-write* (subpath "/private/var/folders/x"))
(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`);
  });

  it("允许网络、不可写", () => {
    expect(buildSbplProfile({ network: "allow", writable: [] })).toBe(`(version 1)
(allow default)
(deny file-write*)
(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`);
  });

  it("字符串转义；控制字符与空路径拒绝", () => {
    expect(sbplString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"');
    expect(() => sbplString("/a\nb")).toThrow(/unsupported path/);
    expect(() => sbplString("")).toThrow(/unsupported path/);
    expect(() =>
      buildSbplProfile({ network: "deny", writable: ['/x")(allow network*)(\u0000'] }),
    ).toThrow(/unsupported path/);
  });
});

describe("buildBwrapArgs / buildUnshareArgs（黄金）", () => {
  it("拒绝网络 + 可写目录", () => {
    expect(buildBwrapArgs({ network: "deny", writable: ["/work"] })).toEqual([
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--unshare-net",
      "--bind",
      "/work",
      "/work",
      "--",
    ]);
  });

  it("允许网络：不 unshare-net", () => {
    expect(buildBwrapArgs({ network: "allow", writable: [] })).toEqual([
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--",
    ]);
    expect(() => buildBwrapArgs({ network: "deny", writable: ["/a\tb"] })).toThrow();
  });

  it("unshare", () => {
    expect(buildUnshareArgs()).toEqual(["-r", "-n", "--"]);
  });
});

describe("wrapCommand", () => {
  const real = (p: string): string => {
    if (p === "/missing") throw new Error("ENOENT");
    return p === "/tmp/x" ? "/private/tmp/x" : p;
  };

  it("none：原样返回", () => {
    expect(wrapCommand({ kind: "none" }, "node", ["a"], { network: "deny", writable: [] })).toEqual(
      {
        command: "node",
        args: ["a"],
        sandboxed: false,
        networkDenied: false,
        writesRestricted: false,
      },
    );
  });

  it("sandbox-exec：-p 配置 + 原命令；可写目录取 realpath、丢弃不存在的与重复的", () => {
    const wrapped = wrapCommand(
      { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" },
      "/bin/node",
      ["--permission", "entry.js"],
      { network: "deny", writable: ["/tmp/x", "/missing", "/private/tmp/x"] },
      real,
    );
    expect(wrapped.command).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.args[0]).toBe("-p");
    expect(wrapped.args.slice(2)).toEqual(["/bin/node", "--permission", "entry.js"]);
    expect(wrapped.args[1]).toBe(
      buildSbplProfile({ network: "deny", writable: ["/private/tmp/x"] }),
    );
    expect(wrapped).toMatchObject({ sandboxed: true, networkDenied: true, writesRestricted: true });
  });

  it("bwrap：参数在 -- 之前", () => {
    const wrapped = wrapCommand(
      { kind: "bwrap", path: "/usr/bin/bwrap" },
      "/bin/node",
      ["e.js"],
      { network: "deny", writable: [] },
      real,
    );
    expect(wrapped.args).toEqual([
      ...buildBwrapArgs({ network: "deny", writable: [] }),
      "/bin/node",
      "e.js",
    ]);
  });

  it("unshare：拒绝网络时包装（不限制写入）；允许网络时不包装", () => {
    const status = { kind: "unshare" as const, path: "/usr/bin/unshare" };
    expect(wrapCommand(status, "n", ["e"], { network: "deny", writable: ["/w"] }, real)).toEqual({
      command: "/usr/bin/unshare",
      args: ["-r", "-n", "--", "n", "e"],
      sandboxed: true,
      networkDenied: true,
      writesRestricted: false,
    });
    expect(wrapCommand(status, "n", ["e"], { network: "allow", writable: [] }).sandboxed).toBe(
      false,
    );
  });

  it("resolveWritable 用真实 realpath", () => {
    expect(resolveWritable(["/definitely/not/here"])).toEqual([]);
  });
});
