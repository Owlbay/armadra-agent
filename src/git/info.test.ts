/**
 * 状态行 git 信息（wave5-plan §1.3、§1.4）：分支 / 短提交、detached、worktree、unborn、非 git 目录、
 * numstat 节流、超时与失败降级、AMA_STATUS_GIT=0；[W6] 领先 / 落后上游。[W5-A]
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitInfoWatcher,
  hasUpstream,
  parseLeftRight,
  parseNumstat,
  type NumstatProcess,
  type NumstatSpawn,
} from "./info.js";

const HAS_GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
};

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ama-gitinfo-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function repo(): string {
  const dir = join(root, "proj");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** 假子进程：手动结束。 */
function fakeSpawn(): {
  spawn: NumstatSpawn;
  calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[];
  finish(stdout: string, code?: number): Promise<void>;
  killed: () => number;
} {
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  let current: (EventEmitter & { stdout: PassThrough }) | undefined;
  let kills = 0;
  let spawned: () => void = () => undefined;
  let next = new Promise<void>((resolve) => (spawned = resolve));
  const spawn: NumstatSpawn = (_command, args, options) => {
    calls.push({ args, env: options.env });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      kill: () => {
        kills++;
        return true;
      },
    });
    current = child;
    spawned();
    return child as unknown as NumstatProcess;
  };
  return {
    spawn,
    calls,
    async finish(stdout, code = 0) {
      await next;
      next = new Promise<void>((resolve) => (spawned = resolve));
      const child = current!;
      child.stdout.end(stdout);
      setImmediate(() => child.emit("close", code));
    },
    killed: () => kills,
  };
}

describe("parseNumstat", () => {
  it("累加增删，二进制文件跳过", () => {
    expect(parseNumstat("3\t1\ta.txt\n-\t-\tbin.png\n10\t0\tdir/b.ts\n")).toEqual({
      insertions: 13,
      deletions: 1,
    });
    expect(parseNumstat("")).toEqual({ insertions: 0, deletions: 0 });
  });
});

describe("GitInfoWatcher（假子进程）", () => {
  it("非 git 目录：undefined，不起 numstat", async () => {
    const fake = fakeSpawn();
    const watcher = new GitInfoWatcher(root, { spawn: fake.spawn });
    await watcher.refresh();
    expect(watcher.current()).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it.skipIf(!HAS_GIT)(
    "节流：≥ minInterval 才再起；环境带 GIT_OPTIONAL_LOCKS=0；有变化才通知",
    async () => {
      const dir = repo();
      let now = 0;
      const fake = fakeSpawn();
      const watcher = new GitInfoWatcher(dir, { spawn: fake.spawn, now: () => now });
      let changes = 0;
      watcher.onChange(() => changes++);
      const first = watcher.refresh();
      await fake.finish("2\t1\ta.txt\n");
      await first;
      expect(watcher.current()).toMatchObject({ branch: "main", insertions: 2, deletions: 1 });
      expect(watcher.current()?.shortHead).toMatch(/^[0-9a-f]{7}$/);
      expect(fake.calls[0]?.args).toEqual(["diff", "--numstat", "HEAD"]);
      expect(fake.calls[0]?.env["GIT_OPTIONAL_LOCKS"]).toBe("0");
      expect(changes).toBe(2); // HEAD、增删
      now = 5_000;
      await watcher.refresh();
      expect(fake.calls).toHaveLength(1);
      expect(changes).toBe(2);
      now = 10_000;
      const again = watcher.refresh();
      await fake.finish("2\t1\ta.txt\n");
      await again;
      expect(fake.calls).toHaveLength(2);
      expect(changes).toBe(2);
    },
  );

  it.skipIf(!HAS_GIT)("超时：杀掉子进程、省略增删并停用 numstat，HEAD 照常", async () => {
    const dir = repo();
    let now = 0;
    const fake = fakeSpawn();
    const watcher = new GitInfoWatcher(dir, { spawn: fake.spawn, now: () => now, timeoutMs: 20 });
    await watcher.refresh();
    expect(fake.killed()).toBe(1);
    expect(watcher.current()).toEqual({ branch: "main", shortHead: expect.any(String) });
    expect(watcher.numstatEnabled).toBe(false);
    now = 60_000;
    await watcher.refresh();
    expect(fake.calls).toHaveLength(1);
  });

  it.skipIf(!HAS_GIT)("非零退出同样停用；AMA_STATUS_GIT=0 从不起", async () => {
    const dir = repo();
    const fake = fakeSpawn();
    const watcher = new GitInfoWatcher(dir, { spawn: fake.spawn });
    const run = watcher.refresh();
    await fake.finish("", 128);
    await run;
    expect(watcher.numstatEnabled).toBe(false);
    expect(watcher.current()?.insertions).toBeUndefined();
    const off = fakeSpawn();
    const quiet = new GitInfoWatcher(dir, { spawn: off.spawn, env: { AMA_STATUS_GIT: "0" } });
    await quiet.refresh();
    expect(off.calls).toEqual([]);
    expect(quiet.current()?.branch).toBe("main");
  });
});

describe.skipIf(!HAS_GIT)("GitInfoWatcher（真实 git）", () => {
  it("工作区增删、detached、worktree、unborn", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    const watcher = new GitInfoWatcher(dir, { env: GIT_ENV });
    await watcher.refresh();
    const head = git(dir, "rev-parse", "HEAD");
    expect(watcher.current()).toEqual({
      branch: "main",
      shortHead: head.slice(0, 7),
      insertions: 2,
      deletions: 1,
    });
    // 子目录同样找到仓库
    mkdirSync(join(dir, "sub"));
    const nested = new GitInfoWatcher(join(dir, "sub"), { env: { AMA_STATUS_GIT: "0" } });
    await nested.refresh();
    expect(nested.current()?.branch).toBe("main");
    // detached
    git(dir, "checkout", "-q", "--detach");
    const detached = new GitInfoWatcher(dir, { env: { AMA_STATUS_GIT: "0" } });
    await detached.refresh();
    expect(detached.current()).toEqual({ shortHead: head.slice(0, 7) });
    git(dir, "checkout", "-q", "main");
    // worktree：分支引用在主仓库
    const wt = join(root, "wt");
    git(dir, "worktree", "add", "-q", "-b", "feature", wt);
    const tree = new GitInfoWatcher(wt, { env: { AMA_STATUS_GIT: "0" } });
    await tree.refresh();
    expect(tree.current()).toEqual({ branch: "feature", shortHead: head.slice(0, 7) });
    // unborn：只有分支名
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    git(fresh, "init", "-q", "-b", "trunk");
    const unborn = new GitInfoWatcher(fresh, { env: GIT_ENV });
    await unborn.refresh();
    expect(unborn.current()).toEqual({ branch: "trunk" });
  });
});

describe("[W6] 领先 / 落后上游", () => {
  it("parseLeftRight：左 = 落后、右 = 领先；不认识的输出 undefined", () => {
    expect(parseLeftRight("2\t5\n")).toEqual({ behind: 2, ahead: 5 });
    expect(parseLeftRight("0 0")).toEqual({ behind: 0, ahead: 0 });
    expect(parseLeftRight("fatal: no upstream")).toBeUndefined();
  });

  it.skipIf(!HAS_GIT)("hasUpstream 读 config 的 branch 段（含 worktree 的主仓库 config）", async () => {
    const dir = repo();
    expect(await hasUpstream(dir, "main")).toBe(false);
    git(dir, "checkout", "-q", "-b", "feature", "--track", "main");
    expect(await hasUpstream(dir, "feature")).toBe(true);
    expect(await hasUpstream(dir, "main")).toBe(false);
    const wt = join(root, "wt");
    git(dir, "worktree", "add", "-q", wt, "main");
    expect(await hasUpstream(wt, "feature")).toBe(true);
    expect(await hasUpstream(join(root, "nowhere"), "feature")).toBe(false);
  });

  it.skipIf(!HAS_GIT)("真实 git：↑ 领先、↓ 落后；无上游与 detached 不显示", async () => {
    const dir = repo();
    const plain = new GitInfoWatcher(dir, { env: GIT_ENV });
    await plain.refresh();
    expect(plain.current()?.ahead).toBeUndefined();
    git(dir, "checkout", "-q", "-b", "feature", "--track", "main");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "feature 1");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "main 1");
    git(dir, "commit", "-q", "--allow-empty", "-m", "main 2");
    git(dir, "checkout", "-q", "feature");
    const watcher = new GitInfoWatcher(dir, { env: GIT_ENV });
    await watcher.refresh();
    expect(watcher.current()).toMatchObject({ branch: "feature", ahead: 1, behind: 2 });
    git(dir, "checkout", "-q", "--detach");
    const detached = new GitInfoWatcher(dir, { env: GIT_ENV });
    await detached.refresh();
    expect(detached.current()?.ahead).toBeUndefined();
  });

  it.skipIf(!HAS_GIT)("rev-list 超时：本会话停用领先 / 落后，numstat 照常", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "feature", "--track", "main");
    let now = 0;
    const fake = fakeSpawn();
    const watcher = new GitInfoWatcher(dir, { spawn: fake.spawn, now: () => now, timeoutMs: 50 });
    const first = watcher.refresh();
    await fake.finish("1\t0\ta.txt\n");
    await first;
    expect(fake.calls.map((c) => c.args[0])).toEqual(["diff", "rev-list"]);
    expect(fake.calls[1]?.args).toEqual([
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
    expect(watcher.current()).toMatchObject({ insertions: 1, deletions: 0 });
    expect(watcher.current()?.ahead).toBeUndefined();
    now = 60_000;
    const again = watcher.refresh();
    await fake.finish("1\t0\ta.txt\n");
    await again;
    expect(fake.calls.map((c) => c.args[0])).toEqual(["diff", "rev-list", "diff"]);
  });
});
