/**
 * Windows 上取锁的竞争（CI windows-latest 偶发）：上一个持锁进程刚删掉锁文件时，`open(wx)` 报 EPERM 而不是
 * EEXIST。这里把平台假装成 win32、让前两次 `open(wx)` 报 EPERM，取锁应继续等而不是抛错。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({ eperm: 0, platform: process.platform }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (args[1] === "wx" && injected.eperm > 0) {
        injected.eperm--;
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return real.openSync(...args);
    },
  };
});

const { withRefreshLock } = await import("./token-store.js");

describe("withRefreshLock（win32）", () => {
  beforeEach(() => Object.defineProperty(process, "platform", { value: "win32" }));
  afterEach(() => Object.defineProperty(process, "platform", { value: injected.platform }));

  it("锁文件删除挂起时 open(wx) 报 EPERM：当作被占用继续等，随后取到锁", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ama-lock-")), "auth.json");
    injected.eperm = 2;
    await expect(withRefreshLock(file, async () => "ok")).resolves.toBe("ok");
    expect(injected.eperm).toBe(0);
  });

  it("一直 EPERM 就按等待上限报 auth_lock_timeout（不当成致命错误立即抛）", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ama-lock-")), "auth.json");
    injected.eperm = 1_000;
    await expect(withRefreshLock(file, async () => "ok", { waitMs: 200 })).rejects.toMatchObject({
      code: "auth_lock_timeout",
    });
    injected.eperm = 0;
  });
});
