import { describe, expect, it } from "vitest";
import { isTransientFsError, retryTransientFs } from "./fs-retry.js";

const fail = (code: string) => Object.assign(new Error(code), { code });

describe("fs-retry", () => {
  it("只有 Windows 上的 EPERM / EACCES / EBUSY 算暂时性错误", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      expect(isTransientFsError(code, "win32")).toBe(true);
      expect(isTransientFsError(code, "darwin")).toBe(false);
      expect(isTransientFsError(code, "linux")).toBe(false);
    }
    expect(isTransientFsError("ENOENT", "win32")).toBe(false);
    expect(isTransientFsError(undefined, "win32")).toBe(false);
  });

  it("Windows：暂时性错误按递增间隔重试，成功即返回", () => {
    const sleeps: number[] = [];
    let calls = 0;
    const value = retryTransientFs(
      () => {
        calls++;
        if (calls < 3) throw fail("EPERM");
        return "ok";
      },
      { platform: "win32", delayMs: 10, sleep: (ms) => sleeps.push(ms) },
    );
    expect(value).toBe("ok");
    expect(sleeps).toEqual([10, 20]);
  });

  it("次数用完抛最后的错误；其它错误与非 Windows 平台不重试", () => {
    let calls = 0;
    expect(() =>
      retryTransientFs(
        () => {
          calls++;
          throw fail("EBUSY");
        },
        { platform: "win32", attempts: 3, sleep: () => undefined },
      ),
    ).toThrow("EBUSY");
    expect(calls).toBe(3);
    calls = 0;
    expect(() =>
      retryTransientFs(
        () => {
          calls++;
          throw fail("ENOENT");
        },
        { platform: "win32", sleep: () => undefined },
      ),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
    calls = 0;
    expect(() =>
      retryTransientFs(
        () => {
          calls++;
          throw fail("EPERM");
        },
        { platform: "linux", sleep: () => undefined },
      ),
    ).toThrow("EPERM");
    expect(calls).toBe(1);
  });
});
