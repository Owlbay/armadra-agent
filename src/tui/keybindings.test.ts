import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keybindings, loadKeybindingsFile, parseKeybindings } from "./keybindings.js";

describe("键位表", () => {
  it("缺省表", () => {
    const keys = new Keybindings();
    expect(keys.matches("\r", "tui.editor.submit")).toBe(true);
    expect(keys.matches("\x1b[13;2u", "tui.editor.newLine")).toBe(true);
    expect(keys.matches("\n", "tui.editor.newLine")).toBe(true);
    expect(keys.matches("\x1b\r", "app.message.followUp")).toBe(true);
    expect(keys.matches("\x1b[Z", "app.permission.cycle")).toBe(true);
    expect(keys.matches("\x0f", "app.tools.expand")).toBe(true);
    expect(keys.actionsFor("\x1b")).toEqual(["tui.select.cancel", "app.interrupt"]);
  });

  it("覆盖整组替换，空数组禁用", () => {
    const { overrides, warnings } = parseKeybindings({
      "tui.editor.submit": ["ctrl+s"],
      "app.exit": [],
      "app.model.select": "Ctrl+M",
      "nope.action": ["x"],
      "app.clear": 3,
    });
    expect(warnings).toHaveLength(2);
    const keys = new Keybindings(overrides);
    expect(keys.matches("\x13", "tui.editor.submit")).toBe(true);
    expect(keys.matches("\r", "tui.editor.submit")).toBe(false);
    expect(keys.matches("\x04", "app.exit")).toBe(false);
    expect(keys.keys("app.model.select")).toEqual(["ctrl+m"]);
    expect(keys.matches("\x03", "app.clear")).toBe(true);
  });

  it("从文件加载：不存在为空覆盖，坏 JSON 记警告", () => {
    const dir = mkdtempSync(join(tmpdir(), "ama-kb-"));
    expect(loadKeybindingsFile(join(dir, "missing.json"))).toEqual({ overrides: {}, warnings: [] });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{oops");
    expect(loadKeybindingsFile(bad).warnings).toHaveLength(1);
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ "app.interrupt": ["ctrl+g"] }));
    expect(loadKeybindingsFile(good).overrides).toEqual({ "app.interrupt": ["ctrl+g"] });
  });
});
