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
  it("normal 80 列：框宽 64，键值行与警告", () => {
    const header = new StartupHeader(INFO, { theme: plainTheme(), level: "normal" });
    const out = lines(header, 80).map((l) => l.replace(/\s+│$/, " │"));
    expect(out[0]).toBe("╭" + "─".repeat(62) + "╮");
    expect(out).toContain("│ 模型   anthropic/claude-sonnet-4-5@messages · 思考 medium │");
    expect(out).toContain("│ 目录   ~/Projects/armadra-agent · 已信任（trust.json） │");
    expect(out).toContain("│ 模式   Accept edits · 预设 default · codemode on │");
    expect(out).toContain("│ 已加载 CLAUDE.md, AGENTS.md · 3 Skill · 2 模板 · 4 Hook │");
    expect(out).toContain("│ 警告   2 条（ama doctor 查看） │");
    for (const line of header.render(80)) expect(visibleWidth(line)).toBe(64);
  });

  it("< 56 列或 compact：去框去键列；路径从左截断", () => {
    const narrow = { ...INFO, cwd: "~/Projects/some/very/deep/path/armadra-agent" };
    const out = lines(new StartupHeader(narrow, { theme: plainTheme(), level: "normal" }), 40);
    expect(out.slice(0, 4)).toEqual([
      "✻ ama 0.1.0",
      "anthropic/claude-sonnet-4-5 · medium",
      "…e/very/deep/path/armadra-agent · 已信任",
      "Accept edits · default · codemode on",
    ]);
    const compact = new StartupHeader(INFO, {
      theme: plainTheme(),
      level: "normal",
      compact: true,
    });
    expect(lines(compact, 100)[0]).toBe("✻ ama 0.1.0");
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
