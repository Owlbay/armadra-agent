import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("只读子命令不创建配置目录；进入对话的命令首次运行才自动初始化", async () => {
    const home = createTmpHome();
    const configDir = join(home.root, "fresh-config");
    try {
      const io = {
        stdout: () => undefined,
        stderr: () => undefined,
        env: { ...home.env, AMA_CONFIG_DIR: configDir, AMA_NO_LOCAL_PROBE: "1", AMA_NO_INIT: "" },
        cwd: home.cwd,
        stdinIsTTY: false,
        readStdin: async () => "",
        stdinKind: () => "null" as const,
      };
      for (const argv of [
        ["config", "show"],
        ["config", "path"],
        ["doctor"],
        ["models", "list"],
        ["providers", "list"],
        ["auth", "list"],
      ]) {
        await main(argv, { io, processHooks: false });
        expect(existsSync(configDir), argv.join(" ")).toBe(false);
      }
      expect(await main(["-p", "hi", "--model", "fake/echo"], { io, processHooks: false })).toBe(0);
      expect(existsSync(join(configDir, "config.json"))).toBe(true);
    } finally {
      home.cleanup();
    }
  });
});
