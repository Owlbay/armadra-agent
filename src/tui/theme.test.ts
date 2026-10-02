import { describe, expect, it } from "vitest";
import {
  THEME_ANSI16,
  THEME_PALETTES,
  colorCode,
  createTheme,
  detectColorDepth,
  levelColor,
  parseHex,
  plainTheme,
  resolveThemeName,
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

describe("色板 v1", () => {
  const NAMES = [
    "text",
    "muted",
    "dim",
    "accent",
    "success",
    "warning",
    "error",
    "user",
    "assistant",
    "tool",
    "border",
    "code",
    "link",
    "selection",
  ] as const;
  const EXPECTED_256 = {
    dark: [254, 248, 242, 75, 78, 221, 203, 111, 254, 141, 240, 215, 117, 236],
    light: [234, 240, 245, 26, 28, 130, 160, 25, 234, 91, 250, 94, 31, 254],
  } as const;
  const EXPECTED_16 = {
    dark: [7, 7, 8, 12, 10, 11, 9, 12, 7, 13, 8, 11, 14],
    light: [0, 8, 8, 4, 2, 3, 1, 4, 0, 5, 7, 3, 6],
  } as const;

  for (const name of ["dark", "light"] as const) {
    it(`${name}：14 个语义色，256 色回退无损（落在立方 / 灰阶上）`, () => {
      expect(Object.keys(THEME_PALETTES[name]).sort()).toEqual([...NAMES].sort());
      NAMES.forEach((color, i) => {
        const rgb = parseHex(THEME_PALETTES[name][color]);
        expect([color, rgbTo256(rgb)]).toEqual([color, EXPECTED_256[name][i]]);
      });
    });

    it(`${name}：16 色索引表锁定`, () => {
      const theme = createTheme(name, { caps: { colors: 16 } });
      EXPECTED_16[name].forEach((idx, i) => {
        const color = NAMES[i]!;
        expect([color, THEME_ANSI16[name][color]]).toEqual([color, idx]);
        const code = idx < 8 ? 30 + idx : 90 + idx - 8;
        expect(theme.fg(color, "x")).toBe(`\x1b[${code}mx\x1b[39m`);
      });
    });
  }

  it("selection：≥ 256 色作 bg，否则退化为 accent 粗体", () => {
    expect(createTheme("dark", { caps: { colors: 256 } }).bg("selection", "x")).toBe(
      "\x1b[48;5;236mx\x1b[49m",
    );
    expect(createTheme("dark", { caps: { colors: 16 } }).bg("selection", "x")).toBe(
      "\x1b[1m\x1b[94mx\x1b[39m\x1b[22m",
    );
    expect(stripAnsi(createTheme("dark", { caps: { colors: 0 } }).bg("selection", "x"))).toBe("x");
  });

  it("覆盖色在 16 色下按距离取近", () => {
    const theme = createTheme("dark", { caps: { colors: 16 }, overrides: { error: "#cd0000" } });
    expect(theme.fg("error", "x")).toBe("\x1b[31mx\x1b[39m");
  });

  it("levelColor 阈值", () => {
    expect(levelColor(0.1)).toBe("success");
    expect(levelColor(0.7)).toBe("warning");
    expect(levelColor(0.9)).toBe("error");
    expect(levelColor(0.5, { warnAt: 0.5 })).toBe("warning");
  });
});

describe("auto 主题", () => {
  it("COLORFGBG 背景色号决定 dark / light；缺省 dark", () => {
    expect(resolveThemeName("auto", { COLORFGBG: "15;0" })).toBe("dark");
    expect(resolveThemeName("auto", { COLORFGBG: "0;15" })).toBe("light");
    expect(resolveThemeName("auto", { COLORFGBG: "0;default;15" })).toBe("light");
    expect(resolveThemeName("auto", { COLORFGBG: "7;8" })).toBe("dark");
    expect(resolveThemeName("auto", { TERM_PROGRAM: "Apple_Terminal" })).toBe("dark");
    expect(resolveThemeName("auto", {})).toBe("dark");
    expect(resolveThemeName(undefined, { COLORFGBG: "0;15" })).toBe("light");
    expect(resolveThemeName("light", { COLORFGBG: "15;0" })).toBe("light");
  });
});
