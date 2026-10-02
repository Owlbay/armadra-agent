/**
 * 进入 Bypass permissions 前的确认（confirm-dialog.ts、permissions/bypass.ts）：Tab / Shift+Tab 循环、
 * `/permission` 选择器与命令；帧黄金 `test/fixtures/tui/bypass-confirm-*.txt`。
 */

import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.js";
import { currentSession } from "../../cli/compose-session.js";
import { plainTheme } from "../../tui.js";
import { cleanupStarted, golden, snapshot, start, type Started } from "./test-support.js";

afterEach(cleanupStarted);

const TITLE = "进入 Bypass permissions？";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const mode = (s: Started): string => currentSession(s.rt).state.permissionMode;
const screen = (s: Started): string => s.terminal.viewport().join("\n");

async function press(s: Started, key: string): Promise<void> {
  s.type(key);
  await tick();
  s.frame();
}

describe("Bypass 确认：循环", () => {
  for (const [columns, ascii] of [
    [80, false],
    [40, false],
    [80, true],
  ] as const) {
    it(`帧黄金：缺省选中取消 ${columns}x24${ascii ? " ASCII" : ""}`, async () => {
      const s = await start([{ text: "好的，先看看目录结构。" }], {
        columns,
        argv: ["--permission-mode", "auto"],
        theme: plainTheme({ ascii }),
      });
      const settled = s.until((e) => e.type === "agent_settled");
      s.type("整理一下构建脚本");
      s.type("\r");
      await settled;
      await press(s, "\t");
      expect(mode(s)).toBe("auto");
      expect(screen(s)).toContain(TITLE);
      golden(`bypass-confirm-${columns}x24${ascii ? "-ascii" : ""}`, snapshot(s.terminal, "tab"));
      await press(s, "\x1b");
      s.handle.exit(0);
      await s.done;
    });
  }

  it("Enter（缺省取消）跳过 Bypass 回到 Manual；Esc 同样；对话框打开时 Tab 不再循环", async () => {
    const s = await start([], { argv: ["--permission-mode", "auto"] });
    await press(s, "\t");
    await press(s, "\t");
    expect(mode(s)).toBe("auto");
    await press(s, "\r");
    expect(mode(s)).toBe("default");
    expect(screen(s)).not.toContain(TITLE);
    expect(screen(s)).toContain("未进入 Bypass · 权限模式：Manual");
    for (let i = 0; i < 3; i++) await press(s, "\x1b[Z");
    expect(mode(s)).toBe("auto");
    await press(s, "\x1b[Z");
    expect(screen(s)).toContain(TITLE);
    await press(s, "\x1b");
    expect(mode(s)).toBe("default");
    s.handle.exit(0);
    await s.done;
  });

  it("↓ Enter / ↑ Enter / 1 / y 进入；本次运行确认过后不再问", async () => {
    for (const keys of [["\x1b[B", "\r"], ["\x1b[A", "\r"], ["1"], ["y"]]) {
      const s = await start([], { argv: ["--permission-mode", "auto"] });
      await press(s, "\t");
      for (const key of keys) await press(s, key);
      expect(mode(s)).toBe("full-auto");
      expect(screen(s)).toContain("权限模式：Bypass permissions");
      for (let i = 0; i < 4; i++) await press(s, "\t");
      expect(mode(s)).toBe("auto");
      await press(s, "\t");
      expect(screen(s)).not.toContain(TITLE);
      expect(mode(s)).toBe("full-auto");
      s.handle.exit(0);
      await s.done;
      await cleanupStarted();
    }
  });

  it("2 与 n 都是取消；Ctrl+C 取消且不触发退出", async () => {
    for (const key of ["2", "n", "\x03"]) {
      const s = await start([], { argv: ["--permission-mode", "auto"] });
      await press(s, "\t");
      await press(s, key);
      expect(mode(s)).toBe("default");
      s.handle.exit(0);
      expect(await s.done).toBe(0);
      await cleanupStarted();
    }
  });

  it("命令行 --permission-mode full-auto 启动：视为已确认，循环回 Bypass 不再问", async () => {
    const s = await start([], { argv: ["--permission-mode", "full-auto"] });
    for (let i = 0; i < 4; i++) await press(s, "\t");
    expect(mode(s)).toBe("auto");
    await press(s, "\t");
    expect(screen(s)).not.toContain(TITLE);
    expect(mode(s)).toBe("full-auto");
    s.handle.exit(0);
    await s.done;
  });
});

describe("Bypass 确认：/permission", () => {
  it("/permission full-auto：取消保持原模式并提示；确认后切换", async () => {
    const s = await start([], { argv: ["--permission-mode", "plan"] });
    s.type("/permission full-auto");
    await press(s, "\r");
    expect(screen(s)).toContain(TITLE);
    await press(s, "\r");
    expect(mode(s)).toBe("plan");
    expect(screen(s)).toContain("已取消，权限模式仍为 Plan");
    s.type("/permission full-auto");
    await press(s, "\r");
    await press(s, "y");
    expect(mode(s)).toBe("full-auto");
    s.handle.exit(0);
    await s.done;
  });

  it("/permission 选择器选 Bypass（数字 5）→ 确认框；Esc 保持原模式", async () => {
    const s = await start([]);
    s.type("/permission");
    await press(s, "\r");
    expect(screen(s)).toContain("╭─ 权限模式");
    await press(s, "5");
    expect(screen(s)).toContain(TITLE);
    await press(s, "\x1b");
    expect(mode(s)).toBe("default");
    expect(screen(s)).toContain("已取消，权限模式仍为 Manual");
    s.type("/permission");
    await press(s, "\r");
    await press(s, "4");
    expect(screen(s)).not.toContain(TITLE);
    expect(mode(s)).toBe("auto");
    s.handle.exit(0);
    await s.done;
  });
});

describe("Bypass 确认（en）", () => {
  afterEach(() => setLocale("zh"));
  for (const columns of [80, 40]) {
    it(`帧黄金：缺省选中取消 ${columns}x24`, async () => {
      setLocale("en");
      const s = await start([{ text: "Sure, let me look at the layout first." }], {
        columns,
        argv: ["--permission-mode", "auto"],
      });
      const settled = s.until((e) => e.type === "agent_settled");
      s.type("tidy up the build scripts");
      s.type("\r");
      await settled;
      await press(s, "\t");
      expect(screen(s)).toContain("Enter Bypass permissions?");
      golden(`en/bypass-confirm-${columns}x24`, snapshot(s.terminal, "tab"));
      await press(s, "\x1b");
      s.handle.exit(0);
      await s.done;
    });
  }
});
