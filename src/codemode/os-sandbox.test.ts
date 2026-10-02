/**
 * codemode × 操作系统沙箱（docs/sandbox.md）：能力判定真值表、命令行包装、必须有 OS 沙箱时的失败路径，
 * 以及真机上经 OS 沙箱启动的子进程联网被拒、vm 逃逸尝试失败。CI 的 Node 22 / 24 矩阵在 macOS 上覆盖
 * 「strict 依赖 OS 沙箱」的路径。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxEntryForTests } from "../../test/helpers/codemode-sandbox.js";
import { NO_OS_SANDBOX, osSandboxStatus, type OsSandboxStatus } from "../sandbox/detect.js";
import { buildSbplProfile } from "../sandbox/profile.js";
import {
  NETWORK_NOT_ISOLATED,
  codemodeAvailability,
  detectSandboxCapability,
  sandboxCapabilityFor,
  strictNeedsOsSandbox,
} from "./capability.js";
import { runSandbox, sandboxArgs, sandboxCommand, sandboxEnv } from "./host-side.js";
import { DEFAULT_SCRIPT_OPTIONS } from "./protocol.js";
import { buildCodemodeDescription, createCodemodeTool } from "./tool.js";

const SEATBELT: OsSandboxStatus = {
  kind: "sandbox-exec",
  path: "/usr/bin/sandbox-exec",
  isolatesNetwork: true,
  restrictsWrites: true,
  detail: "macOS sandbox-exec",
};
const UNSHARE: OsSandboxStatus = {
  kind: "unshare",
  path: "/usr/bin/unshare",
  isolatesNetwork: true,
  restrictsWrites: false,
  detail: "Linux unshare -r -n",
};

describe("能力判定真值表", () => {
  it("Node 22 / 24：有 OS 沙箱 → strict；没有 → 网络未隔离", () => {
    for (const version of ["22.19.0", "24.21.0"]) {
      expect(detectSandboxCapability(version, undefined, SEATBELT)).toMatchObject({
        strict: true,
        os: SEATBELT,
      });
      expect(detectSandboxCapability(version, undefined, UNSHARE).strict).toBe(true);
      const none = detectSandboxCapability(version, undefined, NO_OS_SANDBOX);
      expect(none.strict).toBe(false);
      expect(none.reason).toContain(NETWORK_NOT_ISOLATED);
    }
    expect(detectSandboxCapability("24.0.0", undefined, SEATBELT).reason).toBe(
      "Node 24: the OS sandbox (sandbox-exec) blocks network; the permission model blocks file access and child processes",
    );
  });

  it("Node ≥ 25：有没有 OS 沙箱都 strict，reason 不变（字节稳定）", () => {
    const a = detectSandboxCapability("26.0.0", undefined, SEATBELT);
    const b = detectSandboxCapability("26.0.0", undefined, NO_OS_SANDBOX);
    expect(a.strict && b.strict).toBe(true);
    expect(a.reason).toBe(b.reason);
  });

  it("传假设版本时不探测 OS 沙箱；strictNeedsOsSandbox 只在 Node < 25 且 strict 时为真", () => {
    expect(detectSandboxCapability("24.0.0").os).toBe(NO_OS_SANDBOX);
    expect(strictNeedsOsSandbox(detectSandboxCapability("24.0.0", undefined, SEATBELT))).toBe(true);
    expect(strictNeedsOsSandbox(detectSandboxCapability("26.0.0", undefined, SEATBELT))).toBe(
      false,
    );
    expect(strictNeedsOsSandbox(detectSandboxCapability("24.0.0"))).toBe(false);
  });

  it("sandbox.enabled: off → 运行时能力不含 OS 沙箱", () => {
    expect(sandboxCapabilityFor({ sandbox: { enabled: "off" } }).os.kind).toBe("none");
  });

  it("requireStrict：有 OS 沙箱时可用；没有时禁用并写明原因", () => {
    expect(
      codemodeAvailability(true, detectSandboxCapability("24.0.0", undefined, SEATBELT)).available,
    ).toBe(true);
    const off = codemodeAvailability(true, detectSandboxCapability("24.0.0"));
    expect(off.available).toBe(false);
    expect(off.warning).toMatch(/也没有可用的操作系统沙箱（没有可用的操作系统沙箱；/);
  });

  it("工具：OS 沙箱让 Node 24 的 codemode 变 read 类、描述不带 Sandbox 行", () => {
    const capability = detectSandboxCapability("24.0.0", undefined, SEATBELT);
    expect(createCodemodeTool({ listTools: () => [], capability }).permission).toBe("read");
    expect(buildCodemodeDescription([], 3000, capability, "on")).not.toContain("Sandbox:");
    expect(buildCodemodeDescription([], 3000, detectSandboxCapability("24.0.0"), "on")).toContain(
      `Sandbox: Node 24: ${NETWORK_NOT_ISOLATED}`,
    );
  });
});

describe("命令行包装", () => {
  it("sandbox-exec：拒绝网络、不可写的配置 + 原命令行", () => {
    const args = sandboxArgs("/e.cjs", { permissionFlag: "--permission" });
    const wrapped = sandboxCommand("/bin/node", args, SEATBELT);
    expect(wrapped.command).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.args).toEqual([
      "-p",
      buildSbplProfile({ network: "deny", writable: [] }),
      "/bin/node",
      ...args,
    ]);
  });

  it("none：不包装", () => {
    expect(sandboxCommand("/bin/node", ["a"], NO_OS_SANDBOX)).toMatchObject({
      command: "/bin/node",
      args: ["a"],
      sandboxed: false,
    });
  });

  it("requireOsSandbox 而没有 OS 沙箱：不起子进程，直接失败", async () => {
    const result = await runSandbox({
      script: "1",
      options: { ...DEFAULT_SCRIPT_OPTIONS },
      tools: [],
      store: {},
      callTool: async () => null,
      signal: new AbortController().signal,
      entry: sandboxEntryForTests(),
      os: NO_OS_SANDBOX,
      requireOsSandbox: true,
    });
    expect(result.ok).toBe(false);
    expect(result.pid).toBeUndefined();
    expect(result.error).toMatch(/requires an OS sandbox/);
  });
});

const os = osSandboxStatus("auto");

describe.skipIf(os.kind === "none")(`真机（${os.kind}，Node ${process.versions.node}）`, () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ama-cm-os-")));
  let server: Server;
  let port = 0;
  let accepted = 0;
  beforeAll(async () => {
    server = createServer((socket) => {
      accepted++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 模拟「脚本已逃出 vm」：在与 codemode 相同的权限参数 + OS 沙箱下直接 net.connect。 */
  it("与 codemode 相同的命令行：脚本即使逃出 vm 也连不上网", async () => {
    const entry = join(tmp, "escaped.cjs");
    writeFileSync(
      entry,
      `const s = require("node:net").connect({ host: "127.0.0.1", port: ${port} });
s.on("connect", () => { process.stdout.write("allowed"); s.destroy(); });
s.on("error", (e) => process.stdout.write(e.code || e.message));`,
    );
    const wrapped = sandboxCommand(process.execPath, sandboxArgs(entry), os);
    const out = await new Promise<string>((resolve) => {
      const child = spawn(wrapped.command, wrapped.args, {
        env: sandboxEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.on("close", () => resolve(stdout));
    });
    expect(out).not.toBe("allowed");
    expect(out).not.toBe("");
    expect(accepted).toBe(0);
  });

  it("codemode 脚本经 OS 沙箱照常运行；经构造器链拿 process 的逃逸尝试失败", async () => {
    const result = await runSandbox({
      script: `const attempts = [
  () => tools.read.constructor.constructor("return process")(),
  () => (async () => {}).constructor("return process")(),
  () => text.constructor("return process")(),
];
for (const a of attempts) { try { const p = await a(); text(typeof p); } catch (e) { text("blocked " + e.name); } }
text(await tools.read({ path: "x" }));`,
      options: { ...DEFAULT_SCRIPT_OPTIONS },
      tools: [{ name: "read", declaration: "read(): unknown;" }],
      store: {},
      callTool: async (name) => `${name}-ok`,
      signal: new AbortController().signal,
      entry: sandboxEntryForTests(),
      os,
      requireOsSandbox: true,
    });
    expect(result.ok).toBe(true);
    expect(result.outputs.slice(0, 3).every((line) => line.startsWith("blocked"))).toBe(true);
    expect(result.outputs[3]).toBe("read-ok");
  });
});
