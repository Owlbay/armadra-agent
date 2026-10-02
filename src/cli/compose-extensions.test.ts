import { describe, expect, it } from "vitest";
import { composeExtensions } from "./compose-extensions.js";
import type { SessionAssembly } from "./deps.js";

describe("composeExtensions（W5-C0 组装表）", () => {
  it("返回工厂数组；每项都是工厂（各批次各加一行，不在此断言条数）", () => {
    const factories = composeExtensions({
      assembly: { config: {} } as unknown as SessionAssembly,
      env: {},
      log: () => {},
    });
    expect(Array.isArray(factories)).toBe(true);
    for (const factory of factories) expect(typeof factory).toBe("function");
  });
});
