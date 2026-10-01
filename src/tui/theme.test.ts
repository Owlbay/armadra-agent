import { describe, expect, it } from "vitest";
import {
  colorCode,
  createTheme,
  detectColorDepth,
  plainTheme,
  rgbTo16,
  rgbTo256,
} from "./theme.js";
import { stripAnsi } from "./ansi.js";

describe("颜色能力探测", () => {
  it("NO_COLOR / TERM=dumb / 非 TTY → 无色", () => {
    expect(detectColorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }, true)).toBe(0);
    expect(detectColorDepth({ TERM: "dumb" }, true)).toBe(0);
    expect(detectColorDepth({ TERM: "xterm-256color" }, false)).toBe(0);
  });
  it("truecolor / 256 / 16", () => {
    expect(detectColorDepth({ COLORTERM: "truecolor" }, true)).toBe(16_777_216);
    expect(detectColorDepth({ TERM: "tmux-256color" }, true)).toBe(256);
    expect(detectColorDepth({ TERM: "xterm" }, true)).toBe(16);
    expect(detectColorDepth({ FORCE_COLOR: "3" }, false)).toBe(16_777_216);
  });
});

describe("颜色降级", () => {
  it("256 色近似", () => {
    expect(rgbTo256([255, 0, 0])).toBe(196);
    expect(rgbTo256([0, 0, 0])).toBe(16);
    expect(rgbTo256([128, 128, 128])).toBe(244);
    expect(rgbTo256([95, 175, 255])).toBe(75);
  });
  it("16 色近似", () => {
    expect(rgbTo16([255, 0, 0])).toBe(9);
    expect(rgbTo16([0, 205, 0])).toBe(2);
    expect(rgbTo16([250, 250, 250])).toBe(15);
  });
  it("各深度的开启序列", () => {
    expect(colorCode("#ff0000", 16_777_216, false)).toBe("\x1b[38;2;255;0;0m");
    expect(colorCode("#ff0000", 256, true)).toBe("\x1b[48;5;196m");
    expect(colorCode("#ff0000", 16, false)).toBe("\x1b[91m");
    expect(colorCode("#cd0000", 16, true)).toBe("\x1b[41m");
    expect(colorCode("#ff0000", 0, false)).toBe("");
  });
});

describe("主题", () => {
  it("dark / light 语义色，按能力降级", () => {
    const dark = createTheme("dark", { caps: { colors: 256 } });
    expect(dark.fg("error", "x")).toMatch(/^\x1b\[38;5;\d+mx\x1b\[39m$/);
    const light = createTheme("light", { caps: { colors: 16_777_216 } });
    expect(light.fg("accent", "x")).toBe("\x1b[38;2;0;95;215mx\x1b[39m");
    expect(light.name).toBe("light");
  });
  it("无色时 fg / bg 原样返回，粗体保留", () => {
    const theme = createTheme("dark", { caps: { colors: 0 } });
    expect(theme.fg("accent", "x")).toBe("x");
    expect(theme.bg("accent", "x")).toBe("x");
    expect(stripAnsi(theme.bold("x"))).toBe("x");
  });
  it("覆盖语义色", () => {
    const theme = createTheme("dark", {
      caps: { colors: 16_777_216 },
      overrides: { accent: "#010203" },
    });
    expect(theme.fg("accent", "x")).toBe("\x1b[38;2;1;2;3mx\x1b[39m");
  });
  it("plainTheme 全部原样", () => {
    const theme = plainTheme();
    expect(theme.bold(theme.fg("error", theme.underline("x")))).toBe("x");
    expect(theme.caps.colors).toBe(0);
  });
});
