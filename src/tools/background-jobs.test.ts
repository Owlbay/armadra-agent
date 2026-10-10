/**
 * 后台 bash（W5-H2 H6）：真子进程（POSIX）；查询形状与权限按 read 处理跨平台。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import { BackgroundJobs, isBackgroundJobQuery, type JobChange } from "./background-jobs.js";
import { createBashTool, type BackgroundStart } from "./bash.js";

const posix = process.platform !== "win32";
let tmp: { dir: string; cleanup(): void };
let jobs: BackgroundJobs;
beforeEach(() => {
  tmp = makeTmpDir();
  jobs = new BackgroundJobs();
});
afterEach(async () => {
  await jobs.disposeAll();
  tmp.cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("后台任务查询的形状", () => {
  it("bash{job} 且不带 command 才算查询", () => {
    expect(isBackgroundJobQuery("bash", { job: "bg1", action: "wait" })).toBe(true);
    expect(isBackgroundJobQuery("bash", { job: "bg1" })).toBe(true);
    expect(isBackgroundJobQuery("bash", { job: "bg1", command: "rm -rf /" })).toBe(false);
    expect(isBackgroundJobQuery("bash", { command: "ls" })).toBe(false);
    expect(isBackgroundJobQuery("read", { job: "bg1" })).toBe(false);
  });

  it("权限管线把查询按 read 处理：default 模式不询问、plan 模式放行；带 command 仍按 execute", () => {
    const pipeline = new PermissionPipeline({ mode: "default", rules: [], cwd: tmp.dir });
    const check = (input: unknown) =>
      pipeline.check({ toolName: "bash", permission: "execute", input, unattended: true }).decision;
    expect(check({ job: "bg1", action: "output" })).toBe("allow");
    expect(check({ command: "touch x", background: true })).toBe("deny"); // 无人值守的 ask → deny
    pipeline.setMode("plan");
    expect(check({ job: "bg1", action: "stop" })).toBe("allow");
  });

  it("未知任务与缺 job 的 action 报错", async () => {
    const tool = createBashTool({ jobs: () => jobs });
    const ctx = makeToolContext(tmp.dir);
    const unknown = await tool.execute({ job: "bg9", action: "wait" }, ctx);
    expect(unknown).toMatchObject({ isError: true, content: "Unknown background job bg9" });
    const noJob = await tool.execute({ action: "wait" }, ctx);
    expect(noJob.isError).toBe(true);
    const mixed = await tool.execute({ job: "bg1", command: "ls" }, ctx);
    expect(mixed.isError).toBe(true);
  });
});

describe.runIf(posix)("后台 bash（真子进程）", () => {
  it("background 立即返回 jobId / outputPath / pid；wait 拿到退出码与输出；事件 started → exited", async () => {
    const changes: JobChange["phase"][] = [];
    jobs.onChange((change) => changes.push(change.phase));
    const tool = createBashTool({ jobs: () => jobs });
    const ctx = makeToolContext(tmp.dir, { outputDir: join(tmp.dir, "out") });
    const started = await tool.execute(
      { command: "echo hello; sleep 0.2; echo bye; exit 3", background: true },
      ctx,
    );
    expect(started.isError).toBeUndefined();
    const info = started.structured as BackgroundStart;
    expect(info.jobId).toBe("bg1");
    expect(typeof info.pid).toBe("number");
    expect(existsSync(info.outputPath)).toBe(true);
    expect(String(started.content)).toContain('"job":"bg1"');

    const waited = await tool.execute({ job: "bg1", action: "wait", timeoutMs: 5000 }, ctx);
    expect(waited.isError).toBe(true); // 非零退出
    expect(String(waited.content)).toContain("hello\nbye");
    expect(String(waited.content)).toContain("[job bg1 exited with code 3;");
    expect(changes).toEqual(["started", "exited"]);
    // wait 已经看到退出：不再经提醒通道通知
    expect(jobs.takeExited()).toEqual([]);
  });

  it("wait 超时返回 still running；output 读当前输出；stop 杀整棵树", async () => {
    const tool = createBashTool({ jobs: () => jobs });
    const ctx = makeToolContext(tmp.dir, { outputDir: tmp.dir });
    const started = await tool.execute(
      { command: "echo up; sleep 30 & wait", background: true },
      ctx,
    );
    const { pid } = started.structured as BackgroundStart;
    const waited = await tool.execute({ job: "bg1", action: "wait", timeoutMs: 100 }, ctx);
    expect(String(waited.content)).toContain("still running");
    const out = await tool.execute({ job: "bg1", action: "output" }, ctx);
    expect(String(out.content)).toMatch(/^up\n/);
    const stopped = await tool.execute({ job: "bg1", action: "stop" }, ctx);
    expect(String(stopped.content)).toContain("stopped");
    expect(alive(pid as number)).toBe(false);
    expect(jobs.takeExited()).toEqual([]); // 停止的不通知
  });

  it("自然退出且没被查询过的任务由 takeExited 取走一次；disposeAll 回收运行中的进程", async () => {
    const tool = createBashTool({ jobs: () => jobs });
    const ctx = makeToolContext(tmp.dir, { outputDir: tmp.dir });
    await tool.execute({ command: "exit 0", background: true }, ctx);
    const long = await tool.execute({ command: "sleep 30", background: true }, ctx);
    await jobs.wait("bg1", 5000);
    expect(jobs.takeExited().map((job) => [job.id, job.exitCode])).toEqual([["bg1", 0]]);
    expect(jobs.takeExited()).toEqual([]);
    const { pid } = long.structured as BackgroundStart;
    expect(alive(pid as number)).toBe(true);
    await jobs.disposeAll();
    expect(alive(pid as number)).toBe(false);
  });

  it("[#155] output(id, { maxBytes }) 按字节上限尾截断；不传按缺省", async () => {
    const tool = createBashTool({ jobs: () => jobs });
    const ctx = makeToolContext(tmp.dir, { outputDir: tmp.dir });
    await tool.execute(
      {
        command: "for i in $(seq 1 600); do echo row-$i-xxxxxxxxxxxxxxxxxxxx; done",
        background: true,
      },
      ctx,
    );
    await jobs.wait("bg1", 5000);
    const capped = jobs.output("bg1", { maxBytes: 2048 });
    expect(capped?.truncated).toBe(true);
    expect(capped?.truncatedBy).toBe("bytes");
    expect(capped?.outputBytes).toBeLessThanOrEqual(2048);
    expect(capped?.content).toContain("row-600-");
    expect(capped?.content).not.toContain("row-1-");
    const full = jobs.output("bg1");
    expect(full?.truncated).toBe(false);
    expect(full?.content).toContain("row-1-");
  });
});
