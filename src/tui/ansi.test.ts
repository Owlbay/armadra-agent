import { describe, expect, it } from "vitest";
import {
  SGR_RESET,
  codePointWidth,
  graphemeWidth,
  padToWidth,
  sliceByColumn,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "./ansi.js";

describe("visibleWidth 宽度表", () => {
  const table: Array<[string, string, number]> = [
    ["ASCII", "hello", 5],
    ["空串", "", 0],
    ["中文", "你好世界", 8],
    ["中英混排", "ab中c", 5],
    ["日文假名", "カタカナ", 8],
    ["韩文", "한국어", 6],
    ["全角标点", "，。！", 6],
    ["全角字母", "ＡＢ", 4],
    ["emoji", "😀", 2],
    ["emoji 序列", "👍🎉", 4],
    ["肤色修饰", "👍🏽", 2],
    ["ZWJ 家庭", "👨‍👩‍👧", 2],
    ["国旗", "🇨🇳", 2],
    ["VS16 心形", "❤️", 2],
    ["文本型心形", "❤", 1],
    ["组合重音 e + ◌́", "é", 1],
    ["预组合 é", "é", 1],
    ["多个组合字符", "à́̂b", 2],
    ["零宽空格", "a​b", 2],
    ["ANSI 颜色跳过", "\x1b[31mred\x1b[0m", 3],
    ["ANSI 256 色", "\x1b[38;5;196m中\x1b[39m", 2],
    ["OSC 8 超链接", "\x1b]8;;https://x.y\x07link\x1b]8;;\x07", 4],
    ["APC 光标标记", "ab\x1b_ama:c\x07cd", 4],
    ["制表符等控制字符", "a\tb", 2],
    ["盒线字符", "╭─╮", 3],
    ["盲文旋转符", "⠋", 1],
  ];
  it.each(table)("%s", (_name, input, width) => {
    expect(visibleWidth(input)).toBe(width);
  });

  it("码点宽度", () => {
    expect(codePointWidth(0x41)).toBe(1);
    expect(codePointWidth(0x4e2d)).toBe(2);
    expect(codePointWidth(0x0301)).toBe(0);
    expect(codePointWidth(0x1f600)).toBe(2);
    expect(codePointWidth(0x07)).toBe(0);
    expect(graphemeWidth("́")).toBe(0);
  });

  it("stripAnsi", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[22m \x1b]8;;u\x1b\\l\x1b]8;;\x1b\\")).toBe("bold l");
  });
});

describe("truncateToWidth", () => {
  it("不超宽时原样返回", () => {
    expect(truncateToWidth("abc", 3)).toBe("abc");
  });
  it("超宽时加省略号", () => {
    expect(truncateToWidth("abcdef", 4)).toBe("abc…");
    expect(truncateToWidth("abcdef", 4, "")).toBe("abcd");
  });
  it("宽字符不被切开", () => {
    const out = truncateToWidth("中文字符", 5);
    expect(out).toBe("中文…");
    expect(visibleWidth(out)).toBeLessThanOrEqual(5);
  });
  it("保留样式并在末尾重置", () => {
    const out = truncateToWidth("\x1b[31mabcdef\x1b[39m", 4);
    expect(out).toBe(`\x1b[31mabc…${SGR_RESET}`);
  });
  it("宽度 0 返回空串", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
  });
});

describe("sliceByColumn", () => {
  it("按列取区间", () => {
    expect(sliceByColumn("abcdef", 2, 4)).toBe("cd");
  });
  it("宽字符跨边界用空格补", () => {
    expect(sliceByColumn("中文字", 1, 4)).toBe(" 文");
    expect(sliceByColumn("中文字", 1, 5)).toBe(" 文 ");
    expect(visibleWidth(sliceByColumn("中文字", 1, 4))).toBe(3);
  });
  it("开头补上已生效的 SGR，末尾重置", () => {
    expect(sliceByColumn("\x1b[32mgreen\x1b[39m", 2, 4)).toBe(`\x1b[32mee${SGR_RESET}`);
  });
  it("重置后的片段不带旧样式", () => {
    expect(sliceByColumn("\x1b[31mab\x1b[0mcd", 2, 4)).toBe("cd");
  });
});

describe("wrapTextWithAnsi", () => {
  it("按词换行", () => {
    expect(wrapTextWithAnsi("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });
  it("超长词硬断", () => {
    expect(wrapTextWithAnsi("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapTextWithAnsi("ab cdefghijkl", 5)).toEqual(["ab cd", "efghi", "jkl"]);
  });
  it("中日韩文字之间可断行", () => {
    expect(wrapTextWithAnsi("› 帮我检查差分渲染", 8)).toEqual(["› 帮我检", "查差分渲", "染"]);
    expect(wrapTextWithAnsi("修改 diff()：首变化", 13)).toEqual(["修改 diff()：", "首变化"]);
  });
  it("保留换行与空行", () => {
    expect(wrapTextWithAnsi("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
  it("中文按列宽断行", () => {
    const lines = wrapTextWithAnsi("中文中文中文", 5);
    expect(lines).toEqual(["中文", "中文", "中文"]);
  });
  it("样式跨行延续", () => {
    const lines = wrapTextWithAnsi("\x1b[31mred red red\x1b[39m", 7);
    expect(lines.map(stripAnsi)).toEqual(["red red", "red"]);
    expect(lines[0]!.endsWith(SGR_RESET)).toBe(true);
    expect(lines[1]!.startsWith("\x1b[31m")).toBe(true);
  });
  it("每行不超过宽度", () => {
    const text = "混合 mixed 文本 with 😀 emoji and 中文 that wraps around several times";
    for (const width of [5, 8, 13, 20]) {
      for (const line of wrapTextWithAnsi(text, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
  it("行首缩进保留", () => {
    expect(wrapTextWithAnsi("  indented", 20)).toEqual(["  indented"]);
  });
});

describe("padToWidth", () => {
  it("补空格到宽度", () => {
    expect(padToWidth("中", 4)).toBe("中  ");
    expect(padToWidth("abcdef", 3)).toBe("abcdef");
  });
});
