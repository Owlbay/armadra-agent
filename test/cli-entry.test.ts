import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/main.js";
import { AMA_VERSION } from "../src/version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("cli 入口", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("AMA_VERSION 取自 package.json", () => {
    expect(AMA_VERSION).toBe(pkg.version);
  });

  it("--version 输出版本并返回 0", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["--version"])).toBe(0);
    expect(write).toHaveBeenCalledWith(`${pkg.version}\n`);
  });
});
