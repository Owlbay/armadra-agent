import { describe, expect, it } from "vitest";
import { visibleWidth } from "./ansi.js";
import {
  ASCII_GLYPHS,
  UNICODE_GLYPHS,
  detectAscii,
  glyphsFor,
  resolveAscii,
  type Glyphs,
} from "./glyphs.js";
import { createTheme, plainTheme } from "./theme.js";

function flatten(glyphs: Glyphs): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(glyphs)) {
    if (key === "ascii" || key === "blocked") continue;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) out.push(...(value as string[]));
    else out.push(...Object.values(value as Record<string, string>));
  }
  return out;
}

describe("字形表", () => {
  it("Unicode 字形都是 1 列宽（与 wcwidth 一致）", () => {
    for (const glyph of flatten(UNICODE_GLYPHS))
      expect([glyph, visibleWidth(glyph)]).toEqual([glyph, 1]);
    for (const glyph of ["⏺", "⎿", "▎", "›", "✻", "✓", "✗"]) expect(visibleWidth(glyph)).toBe(1);
  });

  it("ASCII 字形只含可打印 ASCII", () => {
    for (const glyph of flatten(ASCII_GLYPHS)) expect(glyph).toMatch(/^[\x20-\x7e]+$/);
    expect(ASCII_GLYPHS.spinner).toHaveLength(4);
    expect(UNICODE_GLYPHS.spinner).toHaveLength(10);
  });

  it("两张表的键相同", () => {
    expect(Object.keys(ASCII_GLYPHS).sort()).toEqual(Object.keys(UNICODE_GLYPHS).sort());
    expect(glyphsFor(true)).toBe(ASCII_GLYPHS);
    expect(glyphsFor(false)).toBe(UNICODE_GLYPHS);
  });
});

describe("ASCII 检测", () => {
  it("AMA_ASCII 优先", () => {
    expect(detectAscii({ AMA_ASCII: "1", LANG: "en_US.UTF-8" }, "darwin")).toBe(true);
    expect(detectAscii({ AMA_ASCII: "0", TERM: "linux" }, "linux")).toBe(false);
  });

  it("区域设置不含 UTF-8 → ASCII；LC_ALL 优先于 LANG；都没设 → Unicode", () => {
    expect(detectAscii({ LANG: "C" }, "linux")).toBe(true);
    expect(detectAscii({ LANG: "zh_CN.UTF-8" }, "linux")).toBe(false);
    expect(detectAscii({ LANG: "en_US.utf8" }, "linux")).toBe(false);
    expect(detectAscii({ LC_ALL: "POSIX", LANG: "en_US.UTF-8" }, "linux")).toBe(true);
    expect(detectAscii({}, "linux")).toBe(false);
  });

  it("TERM=linux 与旧 conhost → ASCII；Windows Terminal → Unicode", () => {
    expect(detectAscii({ TERM: "linux", LANG: "en_US.UTF-8" }, "linux")).toBe(true);
    expect(detectAscii({}, "win32")).toBe(true);
    expect(detectAscii({ WT_SESSION: "abc" }, "win32")).toBe(false);
    expect(detectAscii({ TERM_PROGRAM: "vscode" }, "win32")).toBe(false);
  });

  it("resolveAscii：AMA_ASCII > ui.ascii > 检测", () => {
    expect(resolveAscii(false, { AMA_ASCII: "1" }, "linux")).toBe(true);
    expect(resolveAscii(true, {}, "linux")).toBe(true);
    expect(resolveAscii(false, { LANG: "C" }, "linux")).toBe(false);
    expect(resolveAscii(undefined, { LANG: "C" }, "linux")).toBe(true);
  });

  it("主题带字形", () => {
    expect(plainTheme().glyphs).toBe(UNICODE_GLYPHS);
    expect(plainTheme({ ascii: true }).glyphs).toBe(ASCII_GLYPHS);
    expect(createTheme("dark", { caps: { colors: 0 }, ascii: true }).glyphs.tool).toBe("*");
    expect(createTheme("dark", { caps: { colors: 0 }, ascii: false }).glyphs.tool).toBe("⏺");
  });
});
