import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../ansi.js";
import type { Theme } from "../component.js";
import { MemoryTerminal } from "../terminal.js";
import { plainTheme } from "../theme.js";
import { TUI } from "../tui.js";
import { Box } from "./box.js";
import { Card } from "./card.js";
import { KeyValue } from "./key-value.js";
import { Meter } from "./meter.js";

/** 主题着色写成 <色名>文本，便于断言阈值着色。 */
const tagged: Theme = Object.assign(Object.create(plainTheme()) as Theme, {
  fg: (c: string, t: string) => (t === "" ? "" : `<${c}>${t}`),
});

function frame(component: Box | KeyValue | Meter, columns: number, rows = 6): string[] {
  const terminal = new MemoryTerminal({ columns, rows });
  const tui = new TUI(terminal);
  tui.addChild(component);
  tui.start();
  tui.renderNow();
  const out = terminal.viewport().map((l) => l.replace(/\s+$/, ""));
  tui.stop();
  return out;
}

const ROWS = [
  { key: "会话", value: "0193a7c2-session" },
  { key: "模型", value: "anthropic/claude-sonnet" },
  { key: "", value: "" },
  { key: "上下文", value: "72%（144k / 200k）" },
  { key: "说明", value: "第一行\n第二行" },
];

describe("KeyValue", () => {
  it("帧：两列对齐，空行作间隔，换行折叠", () => {
    expect(frame(new KeyValue(ROWS), 40)).toEqual([
      "会话    0193a7c2-session",
      "模型    anthropic/claude-sonnet",
      "",
      "上下文  72%（144k / 200k）",
      "说明    第一行 ⏎ 第二行",
      "",
    ]);
  });

  it("帧：窄宽度时值截断、超长键按比例截断；放不下值只剩键", () => {
    const kv = new KeyValue([
      { key: "a-very-long-key-name", value: "value" },
      { key: "k", value: "0123456789abcdef" },
    ]);
    expect(frame(kv, 20).slice(0, 2)).toEqual(["a-very-…  value", "k         012345678…"]);
    const lines = kv.render(9);
    expect(lines.every((l) => visibleWidth(l) <= 9)).toBe(true);
    const tiny = new KeyValue([{ key: "abc", value: "x" }], { gap: 2 });
    expect(tiny.render(4)).toEqual(["abc"]);
    expect(tiny.render(2)).toEqual(["a…"]);
  });

  it("键着色、setRows 清缓存", () => {
    const kv = new KeyValue([{ key: "k", value: "v" }], { theme: tagged, keyColor: "accent" });
    expect(kv.render(20)).toEqual(["<accent>k  v"]);
    const first = kv.render(20);
    expect(kv.render(20)).toBe(first);
    kv.setRows([{ key: "x", value: "y" }]);
    expect(kv.render(20)).toEqual(["<accent>x  y"]);
  });
});

describe("Meter", () => {
  it("帧：格子与百分比；放进 Box 里", () => {
    expect(frame(new Meter(0.72, { label: "ctx" }), 30)[0]).toBe("ctx ▮▮▮▮▮▮▮▯▯▯ 72%");
    const theme = plainTheme();
    expect(frame(new Box(new Meter(0.05, { label: "ctx", cells: 5 }), { theme }), 20)).toEqual([
      "╭──────────────────╮",
      "│ ctx ▯▯▯▯▯ 5%     │",
      "╰──────────────────╯",
      "",
      "",
      "",
    ]);
  });

  it("阈值着色：< 70% 绿、≥ 70% 黄、≥ 90% 红；undefined 显示 —", () => {
    const at = (v: number | undefined) => new Meter(v, { cells: 4, theme: tagged }).render(40)[0];
    expect(at(0.5)).toBe("<success>▮▮<dim>▯▯ <success>50%");
    expect(at(0.7)).toBe("<warning>▮▮▮<dim>▯ <warning>70%");
    expect(at(0.95)).toBe("<error>▮▮▮▮ <error>95%");
    expect(at(undefined)).toBe("<dim>▯▯▯▯ <dim>—");
    expect(at(1.7)).toBe("<error>▮▮▮▮ <error>100%");
  });

  it("宽度不够先去格子，再截断；setValue 生效", () => {
    const meter = new Meter(0.42, { label: "ctx" });
    expect(meter.render(10)).toEqual(["ctx 42%"]);
    expect(meter.render(5)).toEqual(["ctx …"]);
    meter.setValue(0.9);
    expect(stripAnsi(meter.render(40)[0] ?? "")).toBe("ctx ▮▮▮▮▮▮▮▮▮▯ 90%");
    expect(meter.level()).toBe("error");
  });
});

describe("KeyValue wrap", () => {
  it("值折行，续行对齐值列；值里的换行也换行", () => {
    const kv = new KeyValue(
      [
        { key: "判定顺序", value: "deny 规则 → Hook deny → 危险命令确认 → 权限模式" },
        { key: "规则", value: "a\nb" },
      ],
      { wrap: true },
    );
    expect(kv.render(30).map((l) => l.replace(/\s+$/, ""))).toEqual([
      "判定顺序  deny 规则 → Hook",
      "          deny → 危险命令确认",
      "          → 权限模式",
      "规则      a",
      "          b",
    ]);
  });
});

describe("Meter / Box 字形", () => {
  it("ASCII 主题：Meter 用 # .，Box 用 + - |", () => {
    const ascii = plainTheme({ ascii: true });
    expect(new Meter(0.3, { theme: ascii, label: "ctx" }).render(30)).toEqual([
      "ctx ###....... 30%",
    ]);
    expect(new Box(new KeyValue([{ key: "a", value: "b" }]), { theme: ascii }).render(8)).toEqual([
      "+------+",
      "| a  b |",
      "+------+",
    ]);
  });

  it("Box.borderColor 只给边框着色", () => {
    const box = new Box(new KeyValue([{ key: "k", value: "v" }]), {
      theme: tagged,
      borderColor: "error",
      title: "危险命令",
    });
    const lines = box.render(16);
    expect(lines[0]).toContain("<error>╭─");
    expect(lines[0]).toContain(" 危险命令 ");
    expect(lines[1]!.startsWith("<error>│")).toBe(true);
  });
});

describe("Card", () => {
  it("左竖条 + 标题 / 副标题；空行只画竖条；按 width - 2 渲染子组件", () => {
    const card = new Card(
      new KeyValue([
        { key: "会话", value: "3f2a9c1e" },
        { key: "", value: "" },
      ]),
      {
        title: "上下文已压缩",
        subtitle: "128k → 24k token",
      },
    );
    expect(card.render(40)).toEqual(["▎ 上下文已压缩  128k → 24k token", "▎ 会话  3f2a9c1e", "▎"]);
    expect(
      new Card(undefined, { title: "x", theme: plainTheme({ ascii: true }) }).render(10),
    ).toEqual(["| x"]);
  });

  it("竖条着色、标题粗体、副标题 muted", () => {
    const [head] = new Card(undefined, { theme: tagged, title: "T", subtitle: "s" }).render(40);
    expect(head).toBe("<border>▎ T  <muted>s");
  });
});
