import { describe, expect, it } from "vitest";
import { plainTheme, stripAnsi } from "../../tui.js";
import { SettingsList, type SettingsRow } from "./settings-list.js";

const ROWS: SettingsRow[] = [
  { id: "ui.theme", group: "UI", label: "Theme", value: "dark", tag: "restart", search: "light" },
  { id: "ui.markdown", group: "UI", label: "Markdown", value: "true", tag: "now" },
  {
    id: "thinkingLevel",
    group: "Model",
    label: "Thinking",
    value: "medium",
    tag: "now",
    note: "from user",
  },
  {
    id: "permission.mode",
    group: "Permission",
    label: "Mode",
    value: "default",
    tag: "now",
    dim: true,
  },
];

const draw = (list: SettingsList, width = 70): string[] =>
  list.render(width).map((l) => stripAnsi(l).replace(/\s+$/, ""));

describe("SettingsList", () => {
  it("groups rows, marks the selection, shows tag and note", () => {
    const list = new SettingsList({ theme: plainTheme() });
    list.setRows(ROWS);
    expect(draw(list)).toEqual([
      "UI",
      "› Theme     dark     restart",
      "  Markdown  true     now",
      "Model",
      "  Thinking  medium   now      from user",
      "Permission",
      "  Mode      default  now",
    ]);
  });

  it("moves with wrap-around and keeps the selection across setRows", () => {
    const list = new SettingsList({ theme: plainTheme() });
    list.setRows(ROWS);
    list.move(-1);
    expect(list.selectedRow?.id).toBe("permission.mode");
    list.setRows([...ROWS].reverse());
    expect(list.selectedRow?.id).toBe("permission.mode");
    list.move(1);
    expect(list.selectedRow?.id).toBe("thinkingLevel");
  });

  it("filters by id, label, value and search text; empty text when nothing matches", () => {
    const list = new SettingsList({ theme: plainTheme(), emptyText: "nothing" });
    list.setRows(ROWS);
    list.setQuery("LIGHT");
    expect(list.visibleRows.map((r) => r.id)).toEqual(["ui.theme"]);
    list.setQuery("permission");
    expect(draw(list)).toEqual(["Permission", "› Mode      default  now"]);
    list.setQuery("zzz");
    expect(draw(list)).toEqual(["nothing"]);
    list.setQuery("");
    expect(list.visibleRows).toHaveLength(4);
  });

  it("scrolls to keep the selection visible and drops columns when narrow", () => {
    const list = new SettingsList({ theme: plainTheme(), maxVisible: 3 });
    list.setRows(ROWS);
    list.move(3);
    expect(draw(list)).toEqual([
      "  Thinking  medium   now      from user",
      "Permission",
      "› Mode      default  now",
    ]);
    list.maxVisible = 10;
    expect(draw(list, 50)[4]).toBe("  Thinking  medium   now");
    expect(draw(list, 40)[4]).toBe("  Thinking  medium");
  });
});
