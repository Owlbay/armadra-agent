import { afterEach, describe, expect, it } from "vitest";
import {
  configureOsSandbox,
  findExecutable,
  osSandboxStatus,
  probeOsSandbox,
  resetOsSandboxForTests,
  resolveSandboxEnabled,
  SANDBOX_EXEC_PATH,
  type ProbeDeps,
} from "./detect.js";

interface FakeOptions {
  platform: NodeJS.Platform;
  executables?: string[];
  /** 命令（绝对路径）→ 退出码；缺省 null（无法启动）。 */
  exits?: Record<string, number | null>;
}

function fake(options: FakeOptions): ProbeDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    platform: options.platform,
    env: { PATH: ["/usr/local/bin", "/usr/bin"].join(options.platform === "win32" ? ";" : ":") },
    isExecutable: (path) => (options.executables ?? []).includes(path),
    run(command, args) {
      calls.push([command, ...args]);
      return options.exits?.[command] ?? null;
    },
    calls,
  };
}

describe("probeOsSandbox 真值表（fake spawn）", () => {
  it("off：不探测", () => {
    const deps = fake({ platform: "darwin", executables: [SANDBOX_EXEC_PATH] });
    const status = probeOsSandbox("off", deps);
    expect(status).toMatchObject({ kind: "none", isolatesNetwork: false });
    expect(status.detail).toMatch(/已关闭/);
    expect(deps.calls).toEqual([]);
  });

  it("macOS：存在且探针成功 → sandbox-exec；探针用拒绝网络与写入的配置跑 /usr/bin/true", () => {
    const deps = fake({
      platform: "darwin",
      executables: [SANDBOX_EXEC_PATH],
      exits: { [SANDBOX_EXEC_PATH]: 0 },
    });
    expect(probeOsSandbox("auto", deps)).toMatchObject({
      kind: "sandbox-exec",
      path: SANDBOX_EXEC_PATH,
      isolatesNetwork: true,
      restrictsWrites: true,
    });
    const [call] = deps.calls;
    expect(call?.[1]).toBe("-p");
    expect(call?.[2]).toContain("(deny network*)");
    expect(call?.[2]).toContain("(deny file-write*)");
    expect(call?.[3]).toBe("/usr/bin/true");
  });

  it("macOS：不存在 / 探针失败（嵌套沙箱）/ 无法启动 → none", () => {
    expect(probeOsSandbox("auto", fake({ platform: "darwin" })).detail).toMatch(/没有/);
    const nested = probeOsSandbox(
      "auto",
      fake({
        platform: "darwin",
        executables: [SANDBOX_EXEC_PATH],
        exits: { [SANDBOX_EXEC_PATH]: 65 },
      }),
    );
    expect(nested).toMatchObject({ kind: "none", isolatesNetwork: false });
    expect(nested.detail).toMatch(/退出码 65/);
    expect(
      probeOsSandbox("auto", fake({ platform: "darwin", executables: [SANDBOX_EXEC_PATH] })).detail,
    ).toMatch(/无法启动/);
  });

  it("Linux：bwrap 可用 → bwrap（不再试 unshare）", () => {
    const deps = fake({
      platform: "linux",
      executables: ["/usr/bin/bwrap", "/usr/bin/unshare"],
      exits: { "/usr/bin/bwrap": 0, "/usr/bin/unshare": 0 },
    });
    expect(probeOsSandbox("auto", deps)).toMatchObject({
      kind: "bwrap",
      path: "/usr/bin/bwrap",
      restrictsWrites: true,
    });
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]).toContain("--unshare-net");
    expect(deps.calls[0]?.at(-1)).toBe("true");
  });

  it("Linux：bwrap 失败 → unshare（只隔离网络）；都失败 → none 并列出原因", () => {
    const fallback = probeOsSandbox(
      "auto",
      fake({
        platform: "linux",
        executables: ["/usr/bin/bwrap", "/usr/bin/unshare"],
        exits: { "/usr/bin/bwrap": 1, "/usr/bin/unshare": 0 },
      }),
    );
    expect(fallback).toMatchObject({
      kind: "unshare",
      isolatesNetwork: true,
      restrictsWrites: false,
    });
    expect(fallback.detail).toMatch(/bwrap 探针失败（退出码 1）/);
    const none = probeOsSandbox(
      "auto",
      fake({
        platform: "linux",
        executables: ["/usr/bin/unshare"],
        exits: { "/usr/bin/unshare": 1 },
      }),
    );
    expect(none).toMatchObject({ kind: "none", isolatesNetwork: false });
    expect(none.detail).toBe(
      "没有 bwrap，unshare 探针失败（退出码 1；可能不允许非特权用户命名空间）",
    );
    expect(probeOsSandbox("auto", fake({ platform: "linux" })).detail).toBe(
      "没有 bwrap，没有 unshare",
    );
  });

  it("Windows / 其它：none", () => {
    expect(probeOsSandbox("auto", fake({ platform: "win32" }))).toMatchObject({
      kind: "none",
      detail: "win32 上没有操作系统沙箱实现",
    });
  });
});

describe("开关与缓存", () => {
  afterEach(() => resetOsSandboxForTests());

  it("AMA_SANDBOX=off 优先于配置", () => {
    expect(resolveSandboxEnabled(undefined, {})).toBe("auto");
    expect(resolveSandboxEnabled("off", {})).toBe("off");
    expect(resolveSandboxEnabled("auto", { AMA_SANDBOX: "off" })).toBe("off");
    expect(resolveSandboxEnabled("auto", { AMA_SANDBOX: "0" })).toBe("off");
    expect(resolveSandboxEnabled("auto", { AMA_SANDBOX: "1" })).toBe("auto");
  });

  it("结果进程内缓存；configureOsSandbox 记下的配置作为缺省", () => {
    const first = osSandboxStatus("auto");
    expect(osSandboxStatus("auto")).toBe(first);
    expect(configureOsSandbox("off").kind).toBe("none");
    expect(osSandboxStatus().kind).toBe("none");
    resetOsSandboxForTests();
    expect(osSandboxStatus()).toEqual(first);
  });

  it("findExecutable 按 PATH 顺序", () => {
    expect(
      findExecutable(
        "bwrap",
        { PATH: "/a:/b" },
        (p) => p === "/b/bwrap" || p === "/c/bwrap",
        "linux",
      ),
    ).toBe("/b/bwrap");
    expect(findExecutable("bwrap", {}, () => true, "linux")).toBeUndefined();
  });
});
