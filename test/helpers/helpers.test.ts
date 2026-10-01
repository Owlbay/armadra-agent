import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createTmpHome, isApiKeyVar, withTmpHome } from "./tmp-home.js";

describe("setup.ts", () => {
  it("AMA_CONFIG_DIR / AMA_DATA_DIR 指向临时目录", () => {
    expect(process.env["AMA_CONFIG_DIR"]?.startsWith(tmpdir())).toBe(true);
    expect(process.env["AMA_DATA_DIR"]?.startsWith(tmpdir())).toBe(true);
  });

  it("不留任何 API Key 环境变量", () => {
    expect(Object.keys(process.env).filter(isApiKeyVar)).toEqual([]);
  });

  it("isApiKeyVar", () => {
    expect(isApiKeyVar("ANTHROPIC_API_KEY")).toBe(true);
    expect(isApiKeyVar("AMA_API_KEY_DEEPSEEK")).toBe(true);
    expect(isApiKeyVar("KIMI_API_KEY")).toBe(true);
    expect(isApiKeyVar("PATH")).toBe(false);
  });
});

describe("tmp-home.ts", () => {
  it("建目录、写文件、权限位", () => {
    const tmp = createTmpHome();
    try {
      expect(existsSync(tmp.configDir)).toBe(true);
      expect(existsSync(tmp.cwd)).toBe(true);
      const file = tmp.write("home/.config/ama/auth.json", { version: 1, providers: {} }, 0o600);
      expect(JSON.parse(tmp.read("home/.config/ama/auth.json"))).toEqual({
        version: 1,
        providers: {},
      });
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(tmp.env["AMA_CONFIG_DIR"]).toBe(tmp.configDir);
    } finally {
      tmp.cleanup();
    }
    expect(existsSync(tmp.root)).toBe(false);
  });

  it("withTmpHome 应用并还原环境", async () => {
    const before = process.env["AMA_CONFIG_DIR"];
    const seen = await withTmpHome((tmp) => {
      expect(process.env["HOME"]).toBe(tmp.home);
      return process.env["AMA_CONFIG_DIR"];
    });
    expect(seen).not.toBe(before);
    expect(process.env["AMA_CONFIG_DIR"]).toBe(before);
  });
});
