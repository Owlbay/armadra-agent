import { describe, expect, it } from "vitest";
import type { StartupInfo } from "../../cli/startup-screen.js";
import { tildePath } from "../../cli/startup-screen.js";
import { plainTheme, visibleWidth } from "../../tui.js";
import { StartupHeader, truncateLeft } from "./startup-header.js";
import { lines } from "./test-support.js";

const INFO: StartupInfo = {
  version: "0.1.0",
  model: "anthropic/claude-sonnet-4-5@messages",
  thinking: "medium",
  cwd: "~/Projects/armadra-agent",
  trusted: true,
  trustSource: "trust.json",
  permissionMode: "auto-edit",
  preset: "default",
  codemode: "on",
  contextFiles: ["CLAUDE.md", "AGENTS.md"],
  skills: 3,
  prompts: 2,
  hooks: 4,
  warnings: 2,
};

describe("启动头", () => {
  it("normal 80 列：字符画在左、信息列在右（顶端对齐），警告与已加载照常列出", () => {
    const header = new StartupHeader(INFO, { theme: plainTheme(), level: "normal" });
    const out = lines(header, 80);
    expect(out).toEqual([
      " ▄███▄  ██▄   ▄██  ▄███▄    ama 0.1.0",
      "██▀ ▀██ ███▄ ▄███ ██▀ ▀██   anthropic/claude-sonnet-4-5@messages · 思考 medium",
      "███████ ██ ▀█▀ ██ ███████   ~/Projects/armadra-agent · 已信任（trust.json）",
      "██   ██ ██     ██ ██   ██   Accept edits · 预设 default · codemode on",
      "▀▀   ▀▀ ▀▀     ▀▀ ▀▀   ▀▀   CLAUDE.md, AGENTS.md · 3 Skill · 2 模板 · 4 Hook",
      "                            警告 2 条（ama doctor）",
      "                            /help 命令 · Shift+Tab 切模式 · Ctrl+O 展开工具输出",
    ]);
    for (const line of header.render(80)) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  it("48–71 列：字符画在上，空一行后是信息列；ASCII 用 figlet 字形", () => {
    const bare = { ...INFO, contextFiles: [], skills: 0, prompts: 0, hooks: 0, warnings: 0 };
    const out = lines(new StartupHeader(bare, { theme: plainTheme(), level: "normal" }), 60);
    expect(out.slice(4, 7)).toEqual(["▀▀   ▀▀ ▀▀     ▀▀ ▀▀   ▀▀", "", "ama 0.1.0"]);
    const ascii = new StartupHeader(bare, { theme: plainTheme({ ascii: true }), level: "normal" });
    expect(lines(ascii, 60)[4]).toBe("/_/   \\_\\_|  |_/_/   \\_\\");
  });

  it("< 48 列两行；ui.logo off 与 compact 不画字符画；路径从左截断", () => {
    const narrow = { ...INFO, cwd: "~/Projects/some/very/deep/path/armadra-agent" };
    const out = lines(new StartupHeader(narrow, { theme: plainTheme(), level: "normal" }), 40);
    expect(out).toEqual([
      "✻ ama 0.1.0 · anthropic/claude-sonnet-4…",
      "Accept edits · …h/armadra-agent · 已信任",
      "警告 2 条（ama doctor）",
    ]);
    for (const option of [{ logo: "off" as const }, { compact: true }]) {
      const header = new StartupHeader(INFO, { theme: plainTheme(), level: "normal", ...option });
      expect(header.hasLogo(100)).toBe(false);
      expect(lines(header, 100)[0]).toBe("✻ ama 0.1.0");
      expect(lines(header, 100)[1]).toBe("anthropic/claude-sonnet-4-5@messages · 思考 medium");
    }
  });

  it("header：一行；Bypass 模式名照常显示", () => {
    const info = { ...INFO, permissionMode: "full-auto" as const };
    expect(lines(new StartupHeader(info, { theme: plainTheme(), level: "header" }), 80)).toEqual([
      "✻ ama 0.1.0 · anthropic/claude-sonnet-4-5 · Bypass permissions · /help",
    ]);
  });

  it("truncateLeft / tildePath", () => {
    expect(truncateLeft("abcdef", 4)).toBe("…def");
    expect(truncateLeft("abc", 4)).toBe("abc");
    expect(truncateLeft("abcdef", 4, "...")).toBe("...f");
    expect(tildePath("/home/u/p", "/home/u")).toBe("~/p");
    expect(tildePath("/home/u", "/home/u/")).toBe("~");
    expect(tildePath("/home/uv/p", "/home/u")).toBe("/home/uv/p");
  });
});
