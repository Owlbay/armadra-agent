import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PidRegistry, pidsFile } from "./pids.js";
import { DriverPool, poolFromConfig } from "./pool.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("DriverPool", () => {
  it("总并发与每 Agent 上限；释放后按序放行", async () => {
    const pool = new DriverPool(3, (id) => (id === "claude" ? 2 : undefined));
    const c1 = await pool.acquire("claude");
    await pool.acquire("claude");
    let c3: (() => void) | undefined;
    void pool.acquire("claude").then((r) => (c3 = r));
    const x1 = await pool.acquire("codex"); // claude 卡在自己的上限，codex 不受阻
    expect(pool.running()).toBe(3);
    let x2: (() => void) | undefined;
    void pool.acquire("codex").then((r) => (x2 = r));
    await tick();
    expect(pool.queued()).toBe(2);
    c1();
    await tick();
    expect(c3).toBeDefined();
    expect(x2).toBeUndefined();
    x1();
    await tick();
    expect(x2).toBeDefined();
    expect(pool.running("claude")).toBe(2);
  });

  it("排队可被 abort", async () => {
    const pool = new DriverPool(1);
    const release = await pool.acquire("a");
    const controller = new AbortController();
    const waiting = pool.acquire("a", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    expect(pool.queued()).toBe(0);
    release();
    release(); // 幂等
    expect(pool.running()).toBe(0);
  });

  it("按配置：缺省 3 / claude 2；agents.<id>.maxConcurrent 覆盖", async () => {
    const pool = poolFromConfig({ maxConcurrent: 5, codex: { maxConcurrent: 1 } });
    await pool.acquire("claude");
    await pool.acquire("claude");
    let third = false;
    void pool.acquire("claude").then(() => (third = true));
    await pool.acquire("codex");
    let codex2 = false;
    void pool.acquire("codex").then(() => (codex2 = true));
    await tick();
    expect([third, codex2]).toEqual([false, false]);
    expect(pool.running()).toBe(3);
  });
});

describe("PidRegistry（孤儿进程）", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("登记 / 删除；只清 owner 已不在、命令行对得上的条目", async () => {
    dir = mkdtempSync(join(tmpdir(), "ama-pids-"));
    const registry = new PidRegistry(pidsFile(dir));
    registry.add(111, "/usr/bin/claude");
    registry.remove(111);
    expect(registry.entries()).toEqual([]);
    mkdirSync(join(dir, "drivers"), { recursive: true });
    const write = (entries: object[]) =>
      writeFileSync(pidsFile(dir), JSON.stringify({ version: 1, entries }));
    write([
      { pid: 10, program: "/usr/local/bin/claude", owner: 1_000_001, startedAt: 0 },
      { pid: 11, program: "codex", owner: 1_000_001, startedAt: 0 },
      { pid: 12, program: "codex", owner: 1_000_002, startedAt: 0 },
      { pid: 13, program: "gemini", owner: process.pid, startedAt: 0 },
    ]);
    const killed: number[] = [];
    const result = await registry.reapOrphans({
      platform: "linux",
      isOwnerAlive: () => false,
      isGroupAlive: (pid) => pid !== 12,
      commandOf: (pid) => (pid === 10 ? "node /usr/local/bin/claude -p" : "vim notes"),
      kill: async (pid) => killed.push(pid),
    });
    expect(result).toEqual([10]);
    expect(killed).toEqual([10]);
    expect(registry.entries().map((e) => e.pid)).toEqual([13]);
  });
});
