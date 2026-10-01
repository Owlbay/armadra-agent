import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../ansi.js";
import { createTheme, plainTheme } from "../theme.js";
import { Markdown, parseMarkdown, renderInline } from "./markdown.js";

const plain = (lines: string[]) => lines.map(stripAnsi);
const theme = createTheme("dark", { caps: { colors: 256 } });

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
      "│ note: keep it small",
      "",
      "name │ size",
      "a.ts │ 12",
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
