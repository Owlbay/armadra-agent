/**
 * bash 工具：真子进程（POSIX）。Windows 分支的可测部分在 shell.test.ts。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { createBashTool, type BashDetails, type BashStructured } from "./bash.js";

const posix = process.platform !== "win32";
let tmp: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => tmp.cleanup());

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(posix)("bash（真子进程）", () => {
  const tool = createBashTool();

  it("合流 stdout / stderr，退出码 0", async () => {
    const r = await tool.execute({ command: "echo out; echo err >&2" }, makeToolContext(tmp.dir));
    expect(r.isError).toBe(false);
    expect(r.content).toBe("out\nerr\n");
    const s = r.structured as BashStructured;
    expect(s.exit_code).toBe(0);
    expect(s.truncated).toBe(false);
    expect(s.wall_time_seconds).toBeGreaterThanOrEqual(0);
  });

  it("[ME-D] 按 ctx.maxResultChars 保留尾部、全文落盘，结果不超过会话上限", async () => {
    const r = await tool.execute(
      { command: "for i in $(seq 1 400); do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done" },
      makeToolContext(tmp.dir, { maxResultChars: 4_000 }),
    );
    const text = r.content as string;
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toContain("line-400-");
    expect(text).not.toContain("line-1-");
    const s = r.structured as BashStructured;
    expect(s.truncated).toBe(true);
    expect(readFileSync(s.full_output_path as string, "utf8")).toContain("line-1-");
  });

  it("非零退出码 → isError 并写明", async () => {
    const r = await tool.execute({ command: "echo bad; exit 3" }, makeToolContext(tmp.dir));
    expect(r.isError).toBe(true);
    expect((r.structured as BashStructured).exit_code).toBe(3);
    expect(r.content).toContain("[exit code: 3]");
  });

  it("信号退出按 128+signo", async () => {
    const r = await tool.execute({ command: "kill -TERM $$" }, makeToolContext(tmp.dir));
    expect((r.structured as BashStructured).exit_code).toBe(143);
  });

  it("注入 AMA_* 环境变量，cwd 参数生效", async () => {
    const ctx = makeToolContext(tmp.dir, {
      sessionId: "S1",
      sessionFile: "/tmp/s.jsonl",
      model: { provider: "fake", id: "echo" },
      thinkingLevel: "low",
      depth: 1,
    });
    const r = await tool.execute(
      {
        command:
          'echo "$AMA_SESSION_ID $AMA_SESSION_FILE $AMA_PROVIDER $AMA_MODEL $AMA_THINKING $AMA_DEPTH"; pwd',
        cwd: ".",
      },
      ctx,
    );
    const [envLine, pwdLine] = (r.content as string).split("\n");
    expect(envLine).toBe("S1 /tmp/s.jsonl fake echo low 1");
    expect(pwdLine?.endsWith(tmp.dir.split("/").pop() as string)).toBe(true);
  });

  it("超限尾截断并落盘全文", async () => {
    const ctx = makeToolContext(tmp.dir, { outputDir: join(tmp.dir, "outputs") });
    const r = await tool.execute({ command: "seq 1 3000" }, ctx);
    const s = r.structured as BashStructured;
    expect(s.truncated).toBe(true);
    expect(s.output.split("\n")[0]).toBe("1001");
    expect(s.output.trimEnd().split("\n").at(-1)).toBe("3000");
    expect(s.full_output_path).toBe(join(tmp.dir, "outputs", "bash-call_1.log"));
    expect(existsSync(s.full_output_path as string)).toBe(true);
    expect(readFileSync(s.full_output_path as string, "utf8").split("\n").length).toBe(3001);
    expect(r.content).toContain("[Output truncated: showing the last 2000 of 3000 lines");
  });

  it("流式 onUpdate 给出滚动尾部", async () => {
    const ctx = makeToolContext(tmp.dir);
    await tool.execute({ command: "echo a; sleep 0.3; echo b" }, ctx);
    expect(ctx.updates.length).toBeGreaterThanOrEqual(1);
    expect(ctx.updates.at(-1)).toContain("b");
  });

  it("超时杀整棵进程树（含孙进程）", async () => {
    const pidFile = join(tmp.dir, "child.pid");
    const r = await tool.execute(
      { command: `sleep 30 & echo $! > ${pidFile}; wait`, timeoutMs: 400 },
      makeToolContext(tmp.dir),
    );
    const d = r.details as BashDetails;
    expect(r.isError).toBe(true);
    expect(d.timedOut).toBe(true);
    expect(d.exit_code).toBe(143);
    expect(r.content).toContain("timed out after 400 ms");
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it("忽略 SIGTERM 的进程在 2 s 宽限后被 SIGKILL", async () => {
    const started = Date.now();
    const r = await tool.execute(
      { command: "trap '' TERM; sleep 30", timeoutMs: 300 },
      makeToolContext(tmp.dir),
    );
    const d = r.details as BashDetails;
    expect(d.killedWithSigkill).toBe(true);
    expect(d.exit_code).toBe(137);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  });

  it("abort 级联杀树并标 aborted by user", async () => {
    const ctx = makeToolContext(tmp.dir);
    setTimeout(() => ctx.controller.abort(), 200);
    const r = await tool.execute({ command: "sleep 30" }, ctx);
    expect(r.isError).toBe(true);
    expect((r.details as BashDetails).aborted).toBe(true);
    expect(r.content).toContain("aborted by user");
  });

  it("后台进程占着管道时不挂住", async () => {
    const started = Date.now();
    const r = await tool.execute({ command: "(sleep 5 &) ; echo done" }, makeToolContext(tmp.dir));
    expect(r.content).toBe("done\n");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("参数校验：空命令、超时越界、cwd 不存在", async () => {
    const ctx = makeToolContext(tmp.dir);
    expect((await tool.execute({ command: " " }, ctx)).isError).toBe(true);
    expect((await tool.execute({ command: "ls", timeoutMs: 600_001 }, ctx)).isError).toBe(true);
    expect((await tool.execute({ command: "ls", cwd: "nope" }, ctx)).isError).toBe(true);
  });
});
