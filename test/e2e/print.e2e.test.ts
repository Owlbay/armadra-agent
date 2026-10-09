import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { BUNDLE, hasBundle, runAma } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const script = fileURLToPath(new URL("../fixtures/scripts/tool-then-text.json", import.meta.url));

describe.skipIf(!hasBundle)("e2e：ama -p（bundle 子进程）", () => {
  it("fake/echo：stdout 只有助手文本，退出 0", async () => {
    home = createTmpHome();
    const r = await runAma(home, ["-p", "hi", "--model", "fake/echo"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi\n");
    expect(r.stderr).not.toContain("未捕获");
  });

  it("脚本化工具调用：read 工具执行后给出最终文本；会话落盘", async () => {
    home = createTmpHome();
    home.write("work/README.md", "# demo\n");
    const r = await runAma(home, ["-p", "summarize", "--model", "fake/echo"], {
      env: { AMA_FAKE_SCRIPT: script },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("The README describes the project.\n");
    const list = await runAma(home, ["sessions", "list"]);
    expect(list.stdout).toMatch(/\d+ 条 {2}summarize/);
  });

  it("stream-json 与 stdin 管道拼接；未知模型退出 4", async () => {
    home = createTmpHome();
    const r = await runAma(
      home,
      ["-p", "q", "--model", "fake/echo", "--output-format", "stream-json"],
      {
        input: "from stdin",
      },
    );
    expect(r.code).toBe(0);
    const events = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; prompt?: string });
    expect(events.find((e) => e.type === "before_agent_start")?.prompt).toBe("q\n\nfrom stdin");
    expect(events.at(-1)?.type).toBe("agent_settled");
    const missing = await runAma(home, ["-p", "x", "--model", "fake/none"]);
    expect(missing.code).toBe(4);
  });

  it("零配置：只设 ANTHROPIC_API_KEY 时 config show / doctor 选中 anthropic", async () => {
    home = createTmpHome();
    const env = { ANTHROPIC_API_KEY: "sk-ant-e2e-fake" };
    const show = await runAma(home, ["config", "show"], { env });
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(
      /模型：anthropic\/\S+ {2}零配置：anthropic 有 key（env ANTHROPIC_API_KEY）/,
    );
    const doctor = await runAma(home, ["doctor"], { env });
    expect(doctor.stdout).toMatch(/将使用的模型：anthropic\//);
    expect(doctor.stdout + show.stdout).not.toContain("sk-ant-e2e-fake");
  });

  it("有提示参数、管道保持打开且一直不写：2 s 后继续运行并提示", async () => {
    home = createTmpHome();
    const r = await runWithPipe(home, ["-p", "hi", "--model", "fake/echo"], []);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi\n");
    expect(r.stderr).toContain("未在 2 秒内收到管道输入，已忽略；需要等待请在末尾加 -");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(1_900);
    expect(r.elapsedMs).toBeLessThan(9_000);
  });

  it("先慢 1 s 再写：正常拼接；收到首字节后不再超时（第二块 3.5 s 才到也读进来）", async () => {
    home = createTmpHome();
    const r = await runWithPipe(
      home,
      ["-p", "hi", "--model", "fake/echo"],
      [
        { at: 1_000, text: "slow" },
        { at: 3_500, text: " tail", end: true },
      ],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi\n\nslow tail\n");
    expect(r.stderr).not.toContain("未在");
  });

  it("首字节在 3 s 之后：被忽略并提示", async () => {
    home = createTmpHome();
    const r = await runWithPipe(
      home,
      ["-p", "hi", "--model", "fake/echo"],
      [{ at: 3_000, text: "too late", end: true }],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi\n");
    expect(r.stderr).toContain("未在 2 秒内收到管道输入，已忽略");
  });
});

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const isWindows = process.platform === "win32";

/** npm 子命令：Windows 下 npm 是 .cmd，要经 shell；配置与缓存隔离到临时目录，不联网。 */
function npm(args: string[], cwd: string, sandbox: string): string {
  const quoted = isWindows ? args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)) : args;
  const r = spawnSync("npm", quoted, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
    timeout: 120_000,
    env: {
      ...process.env,
      npm_config_userconfig: join(sandbox, "npmrc"),
      npm_config_cache: join(sandbox, "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  });
  if (r.status !== 0)
    throw new Error(`npm ${args.join(" ")} 失败：${r.stderr}${String(r.error ?? "")}`);
  return r.stdout;
}

describe.skipIf(!hasBundle)("[M-F] e2e：装包后的全局命令走单文件 bundle（D7）", () => {
  it("npm pack → 临时目录 npm install → node_modules/.bin/ama --version", () => {
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "ama-pack-")));
    try {
      writeFileSync(join(sandbox, "npmrc"), "");
      const packs = join(sandbox, "packs");
      mkdirSync(packs);
      npm(["pack", "--pack-destination", packs], ROOT, sandbox);
      const tgz = readdirSync(packs).find((f) => f.endsWith(".tgz"));
      expect(tgz).toBeDefined();
      const app = join(sandbox, "app");
      mkdirSync(app);
      writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", private: true }));
      npm(
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--no-package-lock",
          join(packs, tgz as string),
        ],
        app,
        sandbox,
      );
      const bin = join(app, "node_modules", ".bin", isWindows ? "ama.cmd" : "ama");
      if (!isWindows) {
        expect(realpathSync(bin)).toBe(
          realpathSync(join(app, "node_modules", "@armadra", "agent", "dist", "bundle", "ama.cjs")),
        );
      }
      const r = spawnSync(isWindows ? `"${bin}"` : bin, ["--version"], {
        cwd: app,
        encoding: "utf8",
        shell: isWindows,
        timeout: 30_000,
        env: { ...process.env, HOME: sandbox, AMA_NO_LOCAL_PROBE: "1" },
      });
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        version: string;
      };
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(pkg.version);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 180_000);
});

interface PipeWrite {
  at: number;
  text: string;
  end?: boolean;
}

/** stdin 为管道（父进程持有，不主动关），按时间表写入；返回输出与耗时。 */
function runWithPipe(
  h: TmpHome,
  argv: string[],
  writes: PipeWrite[],
): Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...argv], {
      cwd: h.cwd,
      env: { ...h.env, AMA_NO_LOCAL_PROBE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.stdin.on("error", () => undefined); // 子进程已退出时写入会 EPIPE
    const timers = writes.map((w) =>
      setTimeout(() => {
        if (child.stdin.destroyed) return;
        child.stdin.write(w.text);
        if (w.end === true) child.stdin.end();
      }, w.at),
    );
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ama -p 挂起：${stderr}`));
    }, 15_000);
    child.on("close", (code) => {
      for (const t of timers) clearTimeout(t);
      clearTimeout(kill);
      child.stdin.destroy();
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}
