import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/main.js";
import { AMA_VERSION } from "../src/version.js";
import { createTmpHome } from "./helpers/tmp-home.js";

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

  it("缺省装配：子命令拿到组装根的实现（不再报「尚未装配」）", async () => {
    const home = createTmpHome();
    const out: string[] = [];
    const err: string[] = [];
    try {
      const io = {
        stdout: (t: string) => void out.push(t),
        stderr: (t: string) => void err.push(t),
        env: { ...home.env, AMA_NO_LOCAL_PROBE: "1" },
        cwd: home.cwd,
      };
      expect(await main(["sessions", "list"], { io, processHooks: false })).toBe(0);
      expect(out.join("")).toContain("没有会话");
      expect(err.join("")).not.toContain("尚未装配");
    } finally {
      home.cleanup();
    }
  });
});
