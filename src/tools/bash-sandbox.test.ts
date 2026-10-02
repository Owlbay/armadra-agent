/**
 * [S2] bash 经 OS 沙箱运行（docs/sandbox.md「第二阶段」）：真机（macOS sandbox-exec；Linux 有 bwrap 时）。
 * 没有能限制写入的沙箱（Windows、Linux 没有 bwrap 或不允许用户命名空间）时整组跳过——那时 bash 不包装，
 * 行为与以前相同（最后一组用假状态验证）。
 *
 * 工作区在系统临时目录里；「工作区外」放在仓库目录下的临时子目录（系统临时目录本身在沙箱里可写）。
 */

import { mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import { osSandboxStatus } from "../sandbox/detect.js";
import { NO_OS_SANDBOX } from "../sandbox/detect.js";
import { resolveBashSandbox } from "../sandbox/bash.js";
import { buildClassifierPrompt } from "../permissions/classifier.js";
import { createBashTool, type BashStructured } from "./bash.js";
import { BackgroundJobs } from "./background-jobs.js";

const status = osSandboxStatus("auto");
const usable = status.kind === "sandbox-exec" || status.kind === "bwrap";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ama-bash-sb-")));
const workspace = join(root, "ws");
const home = join(root, "home");
const outside = mkdtempSync(join(process.cwd(), ".ama-sbtest-outside-"));
let server: Server;
let port = 0;
let accepted = 0;

beforeAll(async () => {
  mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
  writeFileSync(join(workspace, ".git", "config"), "[core]\n");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_test"), "SECRET-KEY\n");
  server = createServer((socket) => {
    accepted++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const sandbox = (network: "deny" | "allow" = "deny") =>
  resolveBashSandbox({ bash: "auto", network }, { status, home });
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const connect = () =>
  `${q(process.execPath)} -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('NET_OK');process.exit(0)}).on('error',e=>{console.log('NET_FAIL',e.code);process.exit(7)})"`;

describe.skipIf(!usable)(`bash 沙箱真机（${status.kind}）`, () => {
  it("写工作区成功；写工作区外失败并附沙箱说明", async () => {
    const tool = createBashTool({ sandbox: sandbox() });
    const ok = await tool.execute(
      { command: "echo hi > inside.txt && cat inside.txt" },
      makeToolContext(workspace),
    );
    expect(ok.isError).toBe(false);
    expect((ok.structured as BashStructured).sandboxed).toBe(true);
    const bad = await tool.execute(
      { command: `echo x > ${q(join(outside, "escape.txt"))}` },
      makeToolContext(workspace),
    );
    expect(bad.isError).toBe(true);
    expect(existsSync(join(outside, "escape.txt"))).toBe(false);
    expect(bad.content).toContain("sandbox:false");
  });

  it("系统临时目录可写；.git/hooks、.git/config、.ama/ 只读；凭据目录不可读", async () => {
    const tool = createBashTool({ sandbox: sandbox() });
    const tmpFile = join(tmpdir(), `ama-sb-${process.pid}.txt`);
    const r = await tool.execute(
      {
        command: [
          `echo t > ${q(tmpFile)} && echo TMP_OK`,
          "(echo h > .git/hooks/pre-commit && echo HOOK_WRITTEN) || true",
          "(echo x >> .git/config && echo CONFIG_WRITTEN) || true",
          "(mkdir .ama && echo AMA_WRITTEN) || true",
          `(cat ${q(join(home, ".ssh", "id_test"))} || echo SSH_DENIED) 2>/dev/null`,
        ].join("; "),
      },
      makeToolContext(workspace),
    );
    rmSync(tmpFile, { force: true });
    expect(r.content).toContain("TMP_OK");
    expect(r.content).not.toContain("HOOK_WRITTEN");
    expect(r.content).not.toContain("CONFIG_WRITTEN");
    expect(r.content).not.toContain("SECRET-KEY");
    expect(r.content).toContain("SSH_DENIED");
    expect(existsSync(join(workspace, ".git", "hooks", "pre-commit"))).toBe(false);
    if (status.kind === "sandbox-exec") {
      // bwrap 只能挂到已存在的路径：不存在的 .ama/ 挡不住（docs/sandbox.md 已知限制）
      expect(r.content).not.toContain("AMA_WRITTEN");
      expect(existsSync(join(workspace, ".ama"))).toBe(false);
    }
  });

  it("network: deny 时连本机端口失败；allow 时能连", async () => {
    const before = accepted;
    const denied = await createBashTool({ sandbox: sandbox("deny") }).execute(
      { command: connect() },
      makeToolContext(workspace),
    );
    expect(denied.content).toContain("NET_FAIL");
    expect(accepted).toBe(before);
    const allowed = await createBashTool({ sandbox: sandbox("allow") }).execute(
      { command: connect() },
      makeToolContext(workspace),
    );
    expect(allowed.content).toContain("NET_OK");
  });

  it("sandbox:false 不包装（审批由权限管线负责）", async () => {
    const tool = createBashTool({ sandbox: sandbox() });
    const target = join(outside, "unsandboxed.txt");
    const r = await tool.execute(
      { command: `echo x > ${q(target)} && echo WROTE`, sandbox: false },
      makeToolContext(workspace),
    );
    expect(r.isError).toBe(false);
    expect((r.structured as BashStructured).sandboxed).toBeUndefined();
    expect(existsSync(target)).toBe(true);
  });

  it("后台 bash 也被包装", async () => {
    const jobs = new BackgroundJobs();
    const tool = createBashTool({ sandbox: sandbox(), jobs: () => jobs });
    const ctx = makeToolContext(workspace, { outputDir: join(root, "outputs") });
    const target = join(outside, "bg.txt");
    const started = await tool.execute(
      {
        command: `(echo x > ${q(target)} && echo BG_WROTE) || echo BG_DENIED`,
        background: true,
      },
      ctx,
    );
    expect(started.structured).toMatchObject({ sandboxed: true });
    const jobId = (started.structured as { jobId: string }).jobId;
    const waited = await tool.execute({ job: jobId, action: "wait", timeoutMs: 10_000 }, ctx);
    expect(waited.content).toContain("BG_DENIED");
    expect(existsSync(target)).toBe(false);
    await jobs.disposeAll();
  });
});

describe("沙箱不可用时不包装", () => {
  it("unshare / none：设定不生效，schema 不带 sandbox 参数，命令照常运行", async () => {
    for (const s of [
      NO_OS_SANDBOX,
      {
        kind: "unshare" as const,
        path: "/usr/bin/unshare",
        isolatesNetwork: true,
        restrictsWrites: false,
        detail: "",
      },
    ]) {
      const settings = resolveBashSandbox({ bash: "auto" }, { status: s, home });
      expect(settings.active).toBe(false);
      const tool = createBashTool({ sandbox: settings });
      expect(Object.keys((tool.parameters as { properties: object }).properties)).not.toContain(
        "sandbox",
      );
      expect(tool.description).not.toContain("sandbox");
    }
  });
});

const SEATBELT_FAKE = {
  kind: "sandbox-exec" as const,
  path: "/usr/bin/sandbox-exec",
  isolatesNetwork: true,
  restrictsWrites: true,
  detail: "fake",
};

describe("工具 schema 与分类器输入", () => {
  it("沙箱生效时才有 sandbox 参数与描述末尾一句；关闭时与以前逐字节相同", () => {
    const plain = createBashTool();
    const off = createBashTool({
      sandbox: resolveBashSandbox({ bash: "off" }, { status: SEATBELT_FAKE, home }),
    });
    expect(JSON.stringify([off.description, off.parameters])).toBe(
      JSON.stringify([plain.description, plain.parameters]),
    );
    const on = createBashTool({
      sandbox: resolveBashSandbox({ bash: "auto" }, { status: SEATBELT_FAKE, home }),
    });
    expect(
      (on.parameters as { properties: Record<string, unknown> }).properties["sandbox"],
    ).toEqual({ type: "boolean" });
    expect(on.description.startsWith(plain.description)).toBe(true);
    expect(on.description.length - plain.description.length).toBeLessThan(120);
  });

  it("分类器提示带 os_sandbox 行（只在给了时）", () => {
    const base = { toolName: "bash", input: { command: "make" }, cwd: "/w", projectRoot: "/w" };
    expect(buildClassifierPrompt(base)).not.toContain("os_sandbox");
    expect(buildClassifierPrompt({ ...base, sandbox: { network: "deny" } })).toContain(
      "network blocked",
    );
  });
});
