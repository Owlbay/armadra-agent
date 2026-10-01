import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAmaError } from "../errors.js";
import { displayPath, expandHome, isWithin, resolvePath, toPosix } from "./paths.js";
import { pendingMutexCount, withFileMutex } from "./file-mutex.js";

describe("paths", () => {
  it("展开 ~ 并按 cwd 解析相对路径", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/a", "/h")).toBe(join("/h", "a"));
    expect(expandHome("~user/a", "/h")).toBe("~user/a");
    expect(resolvePath("a/b", "/w")).toBe(resolve("/w", "a/b"));
    expect(resolvePath("/abs/x", "/w")).toBe(resolve("/abs/x"));
    expect(resolvePath("", "/w")).toBe(resolve("/w"));
    expect(resolvePath("~/x", "/w", "/h")).toBe(join("/h", "x"));
  });

  it("拒绝含 NUL 的路径", () => {
    try {
      resolvePath("a\0b", "/w");
      expect.unreachable();
    } catch (err) {
      expect(isAmaError(err) && err.code).toBe("invalid_arguments");
    }
  });

  it("displayPath：cwd 内相对、cwd 外绝对", () => {
    const cwd = resolve("/w/proj");
    expect(displayPath(resolve("/w/proj/src/a.ts"), cwd)).toBe("src/a.ts");
    expect(displayPath(cwd, cwd)).toBe(".");
    expect(displayPath(resolve("/w/other"), cwd)).toBe(toPosix(resolve("/w/other")));
    expect(isWithin(cwd, resolve("/w/proj/x"))).toBe(true);
    expect(isWithin(cwd, resolve("/w/proj2"))).toBe(false);
  });
});

describe("file-mutex", () => {
  it("同一路径串行，不同路径并行，失败不阻塞后继", async () => {
    const order: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const a1 = withFileMutex("/x/a", async () => {
      order.push("a1-start");
      await sleep(30);
      order.push("a1-end");
      throw new Error("boom");
    });
    const a2 = withFileMutex("/x/a", async () => {
      order.push("a2");
      return 2;
    });
    const b = withFileMutex("/x/b", async () => {
      order.push("b");
      return 1;
    });
    await expect(a1).rejects.toThrow("boom");
    expect(await a2).toBe(2);
    expect(await b).toBe(1);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a1-end"));
    expect(order.indexOf("a2")).toBeGreaterThan(order.indexOf("a1-end"));
    expect(pendingMutexCount()).toBe(0);
  });
});
