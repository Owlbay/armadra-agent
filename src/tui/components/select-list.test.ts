import { describe, expect, it } from "vitest";
import { stripAnsi } from "../ansi.js";
import { SelectList, filterItems, type SelectItem } from "./select-list.js";

const items: SelectItem[] = Array.from({ length: 15 }, (_, i) => ({
  value: `m${i}`,
  label: `model-${i}`,
  description: i % 2 === 0 ? "even" : "odd",
  group: i < 8 ? "anthropic" : "openai",
}));

describe("SelectList", () => {
  it("分页视窗跟随选中项，带分组标题与位置提示", () => {
    const list = new SelectList(items, { maxVisible: 4 });
    expect(list.render(30).map(stripAnsi)).toEqual([
      "anthropic",
      "› model-0  even",
      "  model-1  odd",
      "  model-2  even",
      "  model-3  odd",
      "  (1/15)",
    ]);
    for (let i = 0; i < 8; i++) list.handleInput("\x1b[B");
    expect(list.getSelected()?.value).toBe("m8");
    expect(list.render(30).map(stripAnsi)).toEqual([
      "anthropic",
      "  model-5  odd",
      "  model-6  even",
      "  model-7  odd",
      "openai",
      "› model-8  even",
      "  (9/15)",
    ]);
  });

  it("上移在顶部循环到底部；翻页不循环", () => {
    const list = new SelectList(items, { maxVisible: 5 });
    list.handleInput("\x1b[A");
    expect(list.getSelectedIndex()).toBe(14);
    list.handleInput("\x1b[5~");
    expect(list.getSelectedIndex()).toBe(9);
    list.handleInput("\x1b[6~");
    list.handleInput("\x1b[6~");
    expect(list.getSelectedIndex()).toBe(14);
  });

  it("确认与取消回调", () => {
    const picked: string[] = [];
    let cancelled = 0;
    const list = new SelectList(items, {
      onSelect: (item) => picked.push(item.value),
      onCancel: () => cancelled++,
    });
    list.handleInput("\x1b[B");
    list.handleInput("\r");
    list.handleInput("\x1b");
    expect(picked).toEqual(["m1"]);
    expect(cancelled).toBe(1);
  });

  it("可过滤：输入字符追加过滤词，退格删除，保持选中项", () => {
    const list = new SelectList(items, { filterable: true });
    list.selectValue("m12");
    for (const ch of "openai 1") list.handleInput(ch);
    expect(list.getFilter()).toBe("openai 1");
    expect(list.getItems().map((i) => i.value)).toEqual(["m10", "m11", "m12", "m13", "m14"]);
    expect(list.getSelected()?.value).toBe("m12");
    list.handleInput("\x7f");
    list.handleInput("\x7f");
    expect(list.getFilter()).toBe("openai");
    expect(list.render(40)[0]).toBe("> openai");
  });

  it("无匹配时显示空提示", () => {
    const list = new SelectList(items, { filterable: true, emptyText: "nothing" });
    list.setFilter("zzz");
    expect(list.render(20).map(stripAnsi)).toEqual(["> zzz", "  nothing"]);
    expect(list.getSelected()).toBeUndefined();
  });

  it("filterItems 分词匹配", () => {
    expect(filterItems(items, "ODD 3").map((i) => i.value)).toEqual(["m3", "m13"]);
  });
});

describe("SelectList：徽标、数字快捷键、说明换行", () => {
  const modes: SelectItem[] = [
    { value: "a", label: "Alpha", description: "first one", badge: "Default" },
    { value: "b", label: "Beta", description: "second one" },
    { value: "c", label: "Gamma", description: "third one", badge: "Recommended" },
  ];

  it("stacked：说明在下一行；徽标与序号靠右", () => {
    const list = new SelectList(modes, { numberKeys: true, stacked: true });
    expect(list.render(32).map(stripAnsi)).toEqual([
      "› Alpha               Default  1",
      "    first one",
      "  Beta                         2",
      "    second one",
      "  Gamma           Recommended  3",
      "    third one",
    ]);
  });

  it("窄屏放不下徽标时只截断标签，内联说明让位", () => {
    const list = new SelectList(modes, { numberKeys: true });
    for (const line of list.render(20).map(stripAnsi)) expect(line.length).toBeLessThanOrEqual(20);
    expect(stripAnsi(list.render(40)[0] ?? "")).toBe("› Alpha  first one            Default  1");
  });

  it("数字键直接选中并确认；超出范围忽略", () => {
    const picked: string[] = [];
    const list = new SelectList(modes, { numberKeys: true, onSelect: (i) => picked.push(i.value) });
    list.handleInput("3");
    list.handleInput("9");
    expect(picked).toEqual(["c"]);
    expect(list.getSelected()?.value).toBe("c");
  });
});
