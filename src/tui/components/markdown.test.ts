import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../ansi.js";
import type { Theme } from "../component.js";
import { createTheme, plainTheme } from "../theme.js";
import { Markdown, parseMarkdown, renderInline } from "./markdown.js";

const plain = (lines: string[]) => lines.map(stripAnsi);
const theme = createTheme("dark", { caps: { colors: 256 }, ascii: false });

describe("parseMarkdown 分块", () => {
  it("识别各类块", () => {
    const blocks = parseMarkdown(
      [
        "# Title",
        "",
        "para line one",
        "line two",
        "",
        "- a",
        "  - nested",
        "1. first",
        "",
        "> quote",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "---",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "quote",
      "code",
      "hr",
      "table",
    ]);
  });

  it("软换行合并为空格，行尾两个空格为硬换行", () => {
    const [p] = parseMarkdown("a\nb  \nc");
    expect(p).toMatchObject({ kind: "paragraph", text: "a b\nc" });
  });

  it("未闭合的围栏（流式中）按代码块处理", () => {
    const blocks = parseMarkdown("text\n\n```py\nprint(1)");
    expect(blocks[1]).toMatchObject({ kind: "code", lang: "py", lines: ["print(1)"] });
  });
});

describe("renderInline", () => {
  const t = plainTheme();
  it("去掉标记符号", () => {
    expect(renderInline("**bold** and *it* and `code` and ~~gone~~", t)).toBe(
      "bold and it and code and \x1b[9mgone\x1b[29m",
    );
  });
  it("链接显示 URL；snake_case 不当斜体；转义", () => {
    expect(renderInline("[docs](https://x.y) my_var_name \\*lit\\*", t)).toBe(
      "docs (https://x.y) my_var_name *lit*",
    );
    expect(renderInline("<https://a.b>", t)).toBe("https://a.b");
  });
  it("带主题时套样式", () => {
    const out = renderInline("**b** `c`", theme);
    expect(out).toContain("\x1b[1m");
    expect(stripAnsi(out)).toBe("b c");
  });
});

describe("Markdown 组件", () => {
  const sample = [
    "## Plan",
    "",
    "We will **edit** `src/a.ts` then run tests.",
    "",
    "- step one",
    "- step two with a fairly long description that wraps",
    "  - sub step",
    "",
    "```ts",
    "export const answer = 42;",
    "```",
    "",
    "> note: keep it small",
    "",
    "| name | size |",
    "|------|------|",
    "| a.ts | 12 |",
  ].join("\n");

  it("宽 40 渲染（无色）", () => {
    const md = new Markdown(sample);
    expect(md.render(40)).toEqual([
      "Plan",
      "",
      "We will edit src/a.ts then run tests.",
      "",
      "• step one",
      "• step two with a fairly long",
      "  description that wraps",
      "  ◦ sub step",
      "",
      "╭─ ts ─────────────────────────────────╮",
      "│ export const answer = 42;            │",
      "╰──────────────────────────────────────╯",
      "",
      "▎ note: keep it small",
      "",
      "name  size",
      "──────────",
      "a.ts  12",
    ]);
  });

  it("配色：链接 link + 下划线、URL dim；列表符号 muted；代码块正文 text；引用 muted", () => {
    const tagged = Object.assign(Object.create(plainTheme()) as Theme, {
      fg: (c: string, t: string) => `<${c}>${t}</>`,
      underline: (t: string) => `_${t}_`,
    });
    expect(renderInline("见 [说明](docs/tui.md)", tagged)).toBe(
      "见 <link>_说明_</><dim> (docs/tui.md)</>",
    );
    expect(renderInline("[x](x)", tagged)).toBe("<link>_x_</>");
    expect(renderInline("<https://a.b>", tagged)).toBe("<link>_https://a.b_</>");
    const md = new Markdown("- a\n\n```\ncode\n```\n\n> q", { theme: tagged });
    const out = md.render(30).join("\n");
    expect(out).toContain("<muted>•</> a");
    expect(out).toContain("<text>code</>");
    expect(out).toContain("<border>▎</> <muted>q</>");
    expect(out).not.toContain("<code>");
  });

  it("ASCII 主题：圆点、框线、竖条", () => {
    const md = new Markdown("- a\n\n```\nx\n```\n\n> q\n\n---", {
      theme: plainTheme({ ascii: true }),
    });
    expect(md.render(8)).toEqual([
      "- a",
      "",
      "+------+",
      "| x    |",
      "+------+",
      "",
      "| q",
      "",
      "--------",
    ]);
  });

  it("任何宽度下每行不超宽（含样式）", () => {
    const md = new Markdown(sample + "\n\n" + "中文段落".repeat(20), { theme });
    for (const width of [10, 20, 33, 80]) {
      for (const line of md.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("流式追加：只有末块重新渲染，其余块复用缓存", () => {
    const md = new Markdown("# Head\n\nfirst para", { theme });
    const before = md.render(40);
    md.append(" grows");
    const after = md.render(40);
    expect(after[0]).toBe(before[0]);
    expect(plain(after)).toEqual(["Head", "", "first para grows"]);
    expect(md.render(40)).toBe(after);
  });

  it("增量解析：各种切分下追加 1000 次后块数组与全量解析一致", () => {
    const doc = [
      "# Title",
      "para line one",
      "continues  ",
      "hard break",
      "",
      "- a",
      "  cont",
      "",
      "- b",
      "  1. nested",
      "",
      "> quote",
      "> more",
      "",
      "```ts",
      "const x = 1;",
      "",
      "```",
      "| h1 | h2 |",
      "| -- | -- |",
      "| c | d |",
      "***",
      "tail para",
      "- list right after",
      "",
      "",
      "end",
    ].join("\n");
    const text = doc.repeat(8).slice(0, 4000);
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const md = new Markdown("");
    let at = 0;
    for (let n = 0; n < 1000 && at < text.length; n++) {
      const size = 1 + Math.floor(rand() * 7);
      md.append(text.slice(at, at + size));
      at += size;
      expect(md["blocks"]).toEqual(parseMarkdown(text.slice(0, at)));
    }
    md.append(text.slice(at));
    expect(md["blocks"]).toEqual(parseMarkdown(text));
    expect(md.render(50)).toEqual(new Markdown(text).render(50));
  });

  it("增量解析：只重解析尾部——100 KB 按 20 字符追加，解析行数线性", () => {
    const unit = "## h\n\nsome words here\nand more\n\n- item\n- item\n\n```\ncode\n```\n\n";
    const text = unit.repeat(Math.ceil(100_000 / unit.length));
    const md = new Markdown("");
    for (let at = 0; at < text.length; at += 20) md.append(text.slice(at, at + 20));
    const lineCount = text.split("\n").length;
    // 全量重解析会是 (n / 20) × 平均行数 ≈ 数亿行；增量只与追加次数 × 末块行数成正比
    expect(md.parsedLines).toBeLessThan(lineCount * 4);
    expect(md["blocks"]).toEqual(parseMarkdown(text));
  });

  it("setText 以旧文本为前缀时走增量；含 \\r 回落全量", () => {
    const md = new Markdown("a\n\nb");
    md.setText("a\n\nb c");
    expect(plain(md.render(20))).toEqual(["a", "", "b c"]);
    md.append("\r");
    md.append("\nd");
    expect(md["blocks"]).toEqual(parseMarkdown("a\n\nb c\r\nd"));
    md.setText("x");
    expect(plain(md.render(20))).toEqual(["x"]);
  });

  it("代码块长行硬断，表格超宽截断", () => {
    const md = new Markdown("```\n" + "x".repeat(30) + "\n```\n\n| " + "y".repeat(40) + " |");
    const lines = md.render(20);
    expect(lines).toEqual([
      "╭──────────────────╮",
      "│ xxxxxxxxxxxxxxxx │",
      "│ xxxxxxxxxxxxxx   │",
      "╰──────────────────╯",
      "",
      "yyyyyyyyyyyyyyyyyyy…",
    ]);
  });
});
