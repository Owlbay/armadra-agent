import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "../../test/helpers/tool-context.js";
import {
  buildShellArgs,
  buildToolEnv,
  gitBashCandidates,
  resolveShell,
  shellKindOf,
  wrapPowerShellCommand,
} from "./shell.js";
import {
  exitCodeOf,
  isGroupAlive,
  killProcessTree,
  signalExitCode,
  taskkillArgs,
} from "./process-tree.js";
import { OutputAccumulator, sanitizeOutput } from "./output-accumulator.js";

describe("shell 选择", () => {
  it("POSIX：AMA_SHELL → /bin/bash → sh", () => {
    expect(resolveShell({ platform: "linux", env: { AMA_SHELL: "/usr/bin/zsh" } })).toEqual({
      shell: "/usr/bin/zsh",
      kind: "posix",
    });
    expect(resolveShell({ platform: "darwin", env: {}, exists: (p) => p === "/bin/bash" })).toEqual(
      { shell: "/bin/bash", kind: "posix" },
    );
    expect(resolveShell({ platform: "linux", env: {}, exists: () => false })).toEqual({
      shell: "sh",
      kind: "posix",
    });
  });

  it("Windows：AMA_SHELL → Git Bash 已知路径 → PowerShell", () => {
    const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
    const candidates = gitBashCandidates(env);
    expect(candidates[0]).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(candidates).toContain("C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
    const local = "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    expect(resolveShell({ platform: "win32", env, exists: (p) => p === local })).toEqual({
      shell: local,
      kind: "posix",
    });
    expect(resolveShell({ platform: "win32", env, exists: () => false })).toEqual({
      shell: "powershell.exe",
      kind: "powershell",
    });
    expect(
      resolveShell({
        platform: "win32",
        env: { AMA_SHELL: "C:\\x\\pwsh.exe" },
        exists: () => false,
      }).kind,
    ).toBe("powershell");
  });

  it("参数拼装：-c / PowerShell 透传 $LASTEXITCODE / cmd", () => {
    expect(buildShellArgs({ shell: "/bin/bash", kind: "posix" }, "ls")).toEqual(["-c", "ls"]);
    const ps = buildShellArgs({ shell: "powershell.exe", kind: "powershell" }, "git status");
    expect(ps.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(ps[3]).toBe(wrapPowerShellCommand("git status"));
    expect(ps[3]).toContain("exit $LASTEXITCODE");
    expect(buildShellArgs({ shell: "cmd.exe", kind: "cmd" }, "dir")).toEqual([
      "/d",
      "/s",
      "/c",
      "dir",
    ]);
    expect(shellKindOf("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
    expect(shellKindOf("/bin/sh")).toBe("posix");
  });

  it("环境注入并清掉继承的旧值", () => {
    const env = buildToolEnv(
      { PATH: "/bin", AMA_SESSION_FILE: "/stale", AMA_MODEL: "old" },
      { sessionId: "s1", provider: "anthropic", model: "m1", thinkingLevel: "high", depth: 1 },
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      AMA_SESSION_ID: "s1",
      AMA_PROVIDER: "anthropic",
      AMA_MODEL: "m1",
      AMA_THINKING: "high",
      AMA_DEPTH: "1",
    });
    expect(env["AMA_SESSION_FILE"]).toBeUndefined();
  });
});

describe("process-tree", () => {
  it("128 + signo", () => {
    expect(signalExitCode("SIGKILL")).toBe(137);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(exitCodeOf(0, null)).toBe(0);
    expect(exitCodeOf(null, "SIGINT")).toBe(130);
    expect(exitCodeOf(null, null)).toBe(1);
  });

  it("Windows 分支：taskkill /PID <pid> /T /F", async () => {
    const calls: string[][] = [];
    const escalated = await killProcessTree(1234, {
      platform: "win32",
      runTaskkill: async (args) => {
        calls.push([...args]);
      },
    });
    expect(escalated).toBe(false);
    expect(calls).toEqual([["/PID", "1234", "/T", "/F"]]);
    expect(taskkillArgs(5)).toEqual(["/PID", "5", "/T", "/F"]);
  });

  it("POSIX 分支：SIGTERM → 宽限 → SIGKILL（注入 kill）", async () => {
    const sent: [number, NodeJS.Signals | 0][] = [];
    let alive = true;
    const escalated = await killProcessTree(42, {
      platform: "linux",
      graceMs: 120,
      kill: (pid, sig) => {
        sent.push([pid, sig]);
        if (sig === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        if (sig === "SIGKILL") alive = false;
      },
    });
    expect(escalated).toBe(true);
    expect(sent[0]).toEqual([-42, "SIGTERM"]);
    expect(sent.at(-1)).toEqual([-42, "SIGKILL"]);

    const quick: (NodeJS.Signals | 0)[] = [];
    const e2 = await killProcessTree(7, {
      platform: "linux",
      kill: (_pid, sig) => {
        quick.push(sig);
        if (sig === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    expect(e2).toBe(false);
    expect(quick).not.toContain("SIGKILL");
    expect(
      isGroupAlive(1, {
        kill: () => {
          throw Object.assign(new Error("perm"), { code: "EPERM" });
        },
      }),
    ).toBe(true);
  });
});

describe("OutputAccumulator", () => {
  it("小输出原样、不落盘", () => {
    const acc = new OutputAccumulator({ spillPath: () => "/nonexistent/never" });
    acc.append(Buffer.from("hello\nworld\n"));
    const r = acc.finish();
    expect(r).toMatchObject({ output: "hello\nworld\n", truncated: false, totalLines: 2 });
    expect(r.fullOutputPath).toBeUndefined();
  });

  it("跨块的多字节字符不被切坏", () => {
    const acc = new OutputAccumulator({ spillPath: () => "/x" });
    const buf = Buffer.from("汉字");
    acc.append(buf.subarray(0, 2));
    acc.append(buf.subarray(2));
    expect(acc.finish().output).toBe("汉字");
  });

  it("超行数尾截断并补写全文", () => {
    const tmp = makeTmpDir();
    try {
      const path = join(tmp.dir, "out.log");
      const acc = new OutputAccumulator({ maxLines: 3, spillPath: () => path });
      const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
      acc.append(text);
      const r = acc.finish();
      expect(r.output).toBe("l7\nl8\nl9");
      expect(r.truncated).toBe(true);
      expect(r.fullOutputPath).toBe(path);
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(r.totalLines).toBe(10);
    } finally {
      tmp.cleanup();
    }
  });

  it("超内存上限即落盘，之后增量追加", () => {
    const tmp = makeTmpDir();
    try {
      const path = join(tmp.dir, "spill.log");
      const acc = new OutputAccumulator({
        maxBytes: 64,
        memoryLimitBytes: 100,
        spillPath: () => path,
      });
      for (let i = 0; i < 50; i++) acc.append(`row ${i}\n`);
      const r = acc.finish();
      expect(r.truncated).toBe(true);
      expect(r.output.endsWith("row 49\n") || r.output.endsWith("row 49")).toBe(true);
      expect(readFileSync(path, "utf8").split("\n").length).toBe(51);
      expect(acc.tail(2)).toContain("row 49");
    } finally {
      tmp.cleanup();
    }
  });

  it("清洗 ANSI 与控制字符", () => {
    expect(sanitizeOutput("\x1b[31mred\x1b[0m\r\nok\x07\x00")).toBe("red\nok");
  });
});
