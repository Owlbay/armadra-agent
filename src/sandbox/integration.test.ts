/**
 * OS 沙箱真机集成：用本机探测到的沙箱（macOS sandbox-exec；Linux bwrap / unshare）跑 Node 子进程，
 * 验证联网、越界写、允许目录写的实际结果。没有可用沙箱（Windows、没有 bwrap 且不允许用户命名空间的 Linux）
 * 时整组跳过。
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { osSandboxStatus } from "./detect.js";
import { wrapCommand } from "./wrap.js";

const status = osSandboxStatus("auto");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ama-os-sandbox-")));
const allowed = join(tmp, "allowed");
mkdirSync(allowed);
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

/** 子进程里依次尝试：TCP 连本机端口、DNS、写允许目录、写临时目录根（越界），输出 JSON。 */
function probeScript(): string {
  const script = join(tmp, "probe.cjs");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const out = {};
const attempt = (key, fn) => { try { fn(); out[key] = "allowed"; } catch (e) { out[key] = e.code || e.message; } };
attempt("writeAllowed", () => fs.writeFileSync(${JSON.stringify(join(allowed, "ok.txt"))}, "x"));
attempt("writeOutside", () => fs.writeFileSync(${JSON.stringify(join(tmp, "outside.txt"))}, "x"));
const socket = require("node:net").connect({ host: "127.0.0.1", port: ${port} });
socket.on("connect", () => { out.net = "allowed"; socket.destroy(); dns(); });
socket.on("error", (e) => { out.net = e.code || e.message; dns(); });
function dns() {
  require("node:dns").lookup("example.com", (e) => { out.dns = e ? e.code : "allowed"; process.stdout.write(JSON.stringify(out)); });
}
`,
  );
  return script;
}

function run(command: string, args: string[]): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout) as Record<string, string>);
      } catch {
        reject(new Error(`probe failed: ${stdout} ${stderr}`));
      }
    });
  });
}

describe.skipIf(status.kind === "none")(`OS 沙箱真机（${status.kind}）`, () => {
  it("不包装时：能连本机端口、能写临时目录（对照组）", async () => {
    const before = accepted;
    const out = await run(process.execPath, [probeScript()]);
    expect(out["net"]).toBe("allowed");
    expect(out["writeOutside"]).toBe("allowed");
    expect(accepted).toBeGreaterThan(before);
  });

  it("network: deny：连接失败、DNS 失败；写入只限允许目录", async () => {
    const before = accepted;
    const wrapped = wrapCommand(status, process.execPath, [probeScript()], {
      network: "deny",
      writable: [allowed],
    });
    expect(wrapped.sandboxed).toBe(true);
    const out = await run(wrapped.command, wrapped.args);
    expect(out["net"]).not.toBe("allowed");
    expect(out["dns"]).not.toBe("allowed");
    expect(accepted).toBe(before);
    expect(out["writeAllowed"]).toBe("allowed");
    if (status.restrictsWrites) expect(out["writeOutside"]).toBe("EPERM");
  });

  it.skipIf(!status.restrictsWrites)("network: allow 时仍限制写入", async () => {
    const wrapped = wrapCommand(status, process.execPath, [probeScript()], {
      network: "allow",
      writable: [],
    });
    const out = await run(wrapped.command, wrapped.args);
    expect(out["net"]).toBe("allowed");
    expect(out["writeAllowed"]).not.toBe("allowed");
    expect(out["writeOutside"]).not.toBe("allowed");
  });
});

describe.skipIf(process.platform !== "darwin")("macOS 探测", () => {
  it("本机 sandbox-exec 可用（CI 的 macOS runner 也有）", () => {
    expect(status.kind === "sandbox-exec" || process.env["AMA_SANDBOX"] === "off").toBe(true);
  });
});
