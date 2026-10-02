import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sandboxEntryForTests } from "../../test/helpers/codemode-sandbox.js";
import { isGroupAlive } from "../tools/process-tree.js";
import { detectSandboxCapability } from "./capability.js";
import {
  resolveSandboxEntry,
  runSandbox,
  sandboxArgs,
  sandboxEnv,
  type SandboxRunRequest,
} from "./host-side.js";
import { DEFAULT_SCRIPT_OPTIONS } from "./protocol.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ama-host-side-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const nodeMajor = Number(process.versions.node.split(".")[0]);

function request(script: string, overrides: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  return {
    script,
    options: { ...DEFAULT_SCRIPT_OPTIONS },
    tools: ["read", "grep", "bash"].map((name) => ({ name, declaration: `${name}(): unknown;` })),
    store: {},
    callTool: async (name, input) => `${name}:${JSON.stringify(input)}`,
    signal: new AbortController().signal,
    entry: sandboxEntryForTests(),
    ...overrides,
  };
}

/** 用与 codemode 相同的参数跑一个探针入口，拿到权限模型对文件 / 子进程 / 网络的实际结果。 */
function probe(): Promise<Record<string, string>> {
  const secret = join(tmp, "secret.txt");
  writeFileSync(secret, "top secret");
  const entry = join(tmp, "probe.cjs");
  writeFileSync(
    entry,
    `const fs = require("node:fs");
const out = {};
const attempt = (key, fn) => { try { fn(); out[key] = "allowed"; } catch (e) { out[key] = e.code || e.message; } };
attempt("read", () => fs.readFileSync(${JSON.stringify(secret)}, "utf8"));
attempt("write", () => fs.writeFileSync(${JSON.stringify(join(tmp, "w.txt"))}, "x"));
attempt("spawn", () => require("node:child_process").spawnSync("echo", ["hi"]));
attempt("worker", () => new (require("node:worker_threads").Worker)("1", { eval: true }));
attempt("codegen", () => new Function("return 1")());
out.env = Object.keys(process.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").join(",");
const net = require("node:net");
const socket = net.connect({ host: "127.0.0.1", port: 9 });
socket.on("connect", () => { out.net = "allowed"; socket.destroy(); print(); });
socket.on("error", (e) => { out.net = e.code || e.message; print(); });
function print() { process.stdout.write(JSON.stringify(out)); }
`,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, sandboxArgs(entry), {
      env: sandboxEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
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

describe("--permission 子进程（与 codemode 相同参数）", () => {
  it("读其它文件、写文件、起子进程、worker、字符串生成代码都被拒；环境为空", async () => {
    const out = await probe();
    expect(out["read"]).toBe("ERR_ACCESS_DENIED");
    expect(out["write"]).toBe("ERR_ACCESS_DENIED");
    expect(out["spawn"]).toBe("ERR_ACCESS_DENIED");
    expect(out["worker"]).toBe("ERR_ACCESS_DENIED");
    expect(out["codegen"]).not.toBe("allowed");
    expect(out["env"]).toBe("");
  });

  describe.skipIf(nodeMajor < 25)("Node ≥ 25", () => {
    it("联网被拒（strict）", async () => {
      expect(detectSandboxCapability().strict).toBe(true);
      const out = await probe();
      expect(out["net"]).toBe("ERR_ACCESS_DENIED");
    });
  });

  describe.skipIf(nodeMajor >= 25)("Node 22 / 24", () => {
    it("权限模型不管网络：标注为非 strict", async () => {
      expect(detectSandboxCapability().strict).toBe(false);
      const out = await probe();
      expect(out["net"]).not.toBe("ERR_ACCESS_DENIED");
    });
  });
});

describe("runSandbox", () => {
  it("内层调用被拒 → 脚本收到 Error，Promise.allSettled 其余成功；只回脚本输出", async () => {
    const seen: string[] = [];
    const result = await runSandbox(
      request(
        `const r = await Promise.allSettled([
          tools.read({ path: "a" }),
          tools.bash({ command: "rm -rf /" }),
          tools.grep({ pattern: "x" }),
        ]);
        return r.map((x) => x.status === "fulfilled" ? x.value : "ERR " + x.reason.message).join("\\n");`,
        {
          callTool: async (name, input) => {
            seen.push(name);
            if (name === "bash")
              throw new Error("Permission denied: bash(rm -rf /) matches deny rule");
            return `${name}:${JSON.stringify(input)}`;
          },
        },
      ),
    );
    expect(result.ok).toBe(true);
    expect(seen.sort()).toEqual(["bash", "grep", "read"]);
    expect(result.toolCalls).toBe(3);
    expect(result.outputs).toEqual([
      'read:{"path":"a"}\nERR Permission denied: bash(rm -rf /) matches deny rule\ngrep:{"pattern":"x"}',
    ]);
  });

  it("超时：父进程杀掉子进程树，保留已产出输出", async () => {
    const result = await runSandbox(
      request(`text("before"); while (true) {}`, {
        options: { ...DEFAULT_SCRIPT_OPTIONS, timeoutMs: 400 },
      }),
    );
    expect(result).toMatchObject({ ok: false, timedOut: true, outputs: ["before"] });
    expect(result.error).toMatch(/timed out after 400 ms/);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(400);
    expect(result.pid).toBeTypeOf("number");
    if (process.platform !== "win32") {
      const pid = result.pid as number;
      const deadline = Date.now() + 3000;
      while (isGroupAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(isGroupAlive(pid)).toBe(false);
    }
  });

  it("外层 abort：脚本以失败结束，仍在跑的内层调用收到取消", async () => {
    const controller = new AbortController();
    let innerAborted = false;
    const result = await runSandbox(
      request(`text("start"); await tools.read({ path: "slow" }); text("never");`, {
        signal: controller.signal,
        callTool: (_name, _input, signal) =>
          new Promise((_resolve, reject) => {
            setTimeout(() => controller.abort(), 20);
            signal.addEventListener("abort", () => {
              innerAborted = true;
              reject(new Error("cancelled"));
            });
          }),
      }),
    );
    expect(result).toMatchObject({ ok: false, aborted: true, outputs: ["start"] });
    expect(innerAborted).toBe(true);
  });

  it("脚本结束时取消未 await 的内层调用；store 只在成功时带回", async () => {
    let cancelled = 0;
    const slow: SandboxRunRequest["callTool"] = (name, _input, signal) =>
      name === "grep"
        ? new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => {
              cancelled++;
              reject(new Error("cancelled"));
            }),
          )
        : Promise.resolve("ok");
    const ok = await runSandbox(
      request(`tools.grep({ pattern: "never awaited" }); await tools.read({}); store("k", 1);`, {
        callTool: slow,
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.store).toEqual({ k: 1 });
    expect(cancelled).toBe(1);
    const failed = await runSandbox(request(`store("k", 2); throw new Error("x")`));
    expect(failed.ok).toBe(false);
    expect(failed.store).toBeUndefined();
    expect(failed.error).toBe("Error: x (line 1)");
  });

  it("onOutput 流式收到每段输出；入口缺失给出错误", async () => {
    const chunks: string[] = [];
    const result = await runSandbox(
      request(`text("a"); console.log("b"); return "c";`, { onOutput: (t) => chunks.push(t) }),
    );
    expect(chunks).toEqual(["a", "b", "c"]);
    expect(result.outputs).toEqual(chunks);
    const missing = await runSandbox(request("1", { entry: join(tmp, "missing.cjs") }));
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/exited unexpectedly|Failed to start/);
  });
});

describe("入口与参数", () => {
  it("源码树里解析到 sandbox-entry.ts（realpath）", () => {
    expect(resolveSandboxEntry()).toMatch(/src[\\/]codemode[\\/]sandbox-entry\.ts$/);
    expect(resolveSandboxEntry("file:///nonexistent/dir/host-side.js")).toBeUndefined();
  });

  it("参数：权限开关、只读入口、禁字符串生成代码；不授予写 / 子进程 / worker / addon", () => {
    const args = sandboxArgs("/x/ama-sandbox.cjs", { permissionFlag: "--permission" });
    expect(args).toEqual([
      "--permission",
      "--allow-fs-read=/x/ama-sandbox.cjs",
      "--disallow-code-generation-from-strings",
      "/x/ama-sandbox.cjs",
      "--ama-codemode-sandbox",
    ]);
    expect(args.join(" ")).not.toMatch(/allow-(fs-write|child-process|worker|addons|wasi)/);
    expect(sandboxArgs("/e", { permissionFlag: "--experimental-permission" })[0]).toBe(
      "--experimental-permission",
    );
  });

  it("环境：空；Electron 下 ELECTRON_RUN_AS_NODE=1；Windows 保留 SystemRoot", () => {
    const parent = { SECRET_API_KEY: "x", SystemRoot: "C:\\Windows" };
    expect(sandboxEnv(process.versions, "darwin", parent)).toEqual({});
    expect(
      sandboxEnv(
        { ...process.versions, electron: "38.0.0" } as NodeJS.ProcessVersions,
        "linux",
        parent,
      ),
    ).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(sandboxEnv(process.versions, "win32", parent)).toEqual({ SystemRoot: "C:\\Windows" });
  });
});
