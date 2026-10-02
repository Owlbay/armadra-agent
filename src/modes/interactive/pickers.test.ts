import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../session/types.js";
import { Editor, MemoryTerminal, TUI, plainTheme } from "../../tui.js";
import {
  openPicker,
  permissionItems,
  permissionPickerSpec,
  thinkingItems,
  treeItems,
  userMessageTree,
  type PickerHost,
} from "./pickers.js";

const theme = plainTheme();

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test",
  "fixtures",
);

/** 帧黄金（与 src/tui/tui-frames.test.ts 同格式）；更新：AMA_UPDATE_GOLDEN=1。 */
function golden(name: string, terminal: MemoryTerminal): void {
  const { row, col } = terminal.screen.cursor;
  const actual =
    [
      `# viewport ${terminal.columns}x${terminal.rows} cursor=${row},${col}`,
      ...terminal.viewport().map((l) => `|${l}`),
    ].join("\n") + "\n";
  const file = join(FIXTURES, "tui", `${name}.txt`);
  if (process.env["AMA_UPDATE_GOLDEN"] === "1" || (!existsSync(file) && !process.env["CI"])) {
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}
let tui: TUI | undefined;
afterEach(() => tui?.stop());

function host(columns = 80) {
  const terminal = new MemoryTerminal({ columns, rows: 20 });
  tui = new TUI(terminal);
  const editor = new Editor({ theme });
  tui.addChild(editor);
  tui.start();
  tui.setFocus(editor);
  const t = tui;
  const h: PickerHost = {
    theme,
    showOverlay: (c, o) => t.showOverlay(c, o),
    columns: () => terminal.columns,
  };
  const screen = (): string => {
    t.renderNow();
    return terminal.viewport().join("\n");
  };
  return { terminal, editor, h, screen, tui: t };
}

let seq = 0;
function user(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-10-02T1${seq++ % 10}:00:00Z`,
    message: { role: "user", content: text, timestamp: 0 },
  };
}
function reply(id: string, parentId: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-02T10:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "fake",
      provider: "fake",
      model: "echo",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

describe("选择器", () => {
  it("openPicker：居中覆盖层，当前项预选，Enter 返回、焦点回到编辑器", async () => {
    const { terminal, editor, h, screen, tui } = host();
    const picked = openPicker(h, permissionPickerSpec("auto-edit"));
    const shown = screen();
    expect(shown).toContain("╭─ 权限模式");
    expect(shown).toContain("› ✓ Accept edits");
    expect(shown).toContain("↑↓ 选择 · 1-6 直接选 · Enter 确认 · Esc 取消");
    expect(shown).toContain("自动接受文件编辑，执行命令仍询问");
    terminal.sendInput("\x1b[B\r");
    expect((await picked)?.value).toBe("plan");
    expect(tui.getFocus()).toBe(editor);
    expect(screen()).not.toContain("权限模式");
  });

  it("模式选择器：界面顺序、打勾、Default 与 Recommended 徽标、数字键直接选", async () => {
    const items = permissionItems("auto", "plan");
    expect(items.map((i) => i.value)).toEqual([
      "default",
      "auto-edit",
      "plan",
      "auto",
      "full-auto",
      "allowlist",
    ]);
    expect(items.map((i) => i.label)).toEqual([
      "Manual",
      "Accept edits",
      "Plan",
      "Auto",
      "Bypass permissions",
      "Allowlist only",
    ]);
    expect(permissionPickerSpec("auto", "plan").currentValue).toBe("auto");
    expect(items.find((i) => i.badge === "Default")?.badgeColor).toBe("dim");
    expect(items.find((i) => i.badge === "Recommended")?.badgeColor).toBeUndefined();
    expect(items.map((i) => i.badge)).toEqual([
      undefined,
      undefined,
      "Default",
      "Recommended",
      undefined,
      undefined,
    ]);
    expect(permissionItems("default").find((i) => i.value === "default")?.badge).toBe("Default");
    const { terminal, h } = host();
    const picked = openPicker(h, permissionPickerSpec("default"));
    terminal.sendInput("6");
    expect((await picked)?.value).toBe("allowlist");
  });

  for (const columns of [80, 40]) {
    it(`模式选择器帧黄金 ${columns}x24`, () => {
      const terminal = new MemoryTerminal({ columns, rows: 24 });
      tui = new TUI(terminal);
      const editor = new Editor({ theme });
      tui.addChild(editor);
      tui.start();
      tui.setFocus(editor);
      const t = tui;
      void openPicker(
        { theme, showOverlay: (c, o) => t.showOverlay(c, o), columns: () => terminal.columns },
        permissionPickerSpec("auto-edit"),
      );
      t.renderNow();
      golden(`mode-picker-${columns}x24`, terminal);
    });
  }

  it("超过 8 项自动可过滤；Esc 取消返回 undefined", async () => {
    const { terminal, h, screen } = host(40);
    const items = Array.from({ length: 12 }, (_, i) => ({ value: `m${i}`, label: `model-${i}` }));
    let picked = openPicker(h, { title: "模型", items });
    terminal.sendInput("11");
    expect(screen()).toContain("› model-11");
    terminal.sendInput("\r");
    expect((await picked)?.value).toBe("m11");
    picked = openPicker(h, { title: "模型", items });
    terminal.sendInput("\x1b");
    terminal.flushInput();
    expect(await picked).toBeUndefined();
  });

  it("思考级别：模型不支持时标注", () => {
    expect(thinkingItems(true).map((i) => i.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(thinkingItems(false)[1]?.description).toBe("当前模型不支持思考");
    expect(thinkingItems(false)[0]?.description).toBeUndefined();
  });

  it("树：只列用户消息，分叉处缩进，● 标当前分支", () => {
    // u1 → a1 → u2 → a2 → u3（当前）
    //            ↘ u2b → a2b
    const entries = [
      user("u1", null, "第一问"),
      reply("a1", "u1"),
      user("u2", "a1", "第二问"),
      reply("a2", "u2"),
      user("u3", "a2", "第三问"),
      user("u2b", "a1", "换个问法"),
      reply("a2b", "u2b"),
    ];
    const tree = userMessageTree(entries);
    expect(tree.map((n) => n.entry.id)).toEqual(["u1"]);
    expect(tree[0]?.children.map((n) => n.entry.id)).toEqual(["u2", "u2b"]);
    const items = treeItems(
      entries,
      new Set(["u1", "a1", "u2", "a2", "u3"]),
      Date.parse("2026-10-02T20:00:00Z"),
    );
    expect(items.map((i) => i.label)).toEqual([
      "● 第一问",
      "  ● 第二问",
      "  ● 第三问",
      "  ○ 换个问法",
    ]);
    expect(items[0]?.description).toMatch(/小时前$/);
  });

  it("树：多个根同级不缩进；长文本截断", () => {
    const long = "很长".repeat(40);
    const items = treeItems([user("r1", null, "甲"), user("r2", null, long)], new Set(["r2"]), 0);
    expect(items[0]?.label).toBe("○ 甲");
    expect(items[1]?.label.endsWith("…")).toBe(true);
    expect(treeItems([], new Set(), 0)).toEqual([]);
  });
});
