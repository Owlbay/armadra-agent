/**
 * `/config` panel frame goldens (W6-S): real interactive mode + MemoryTerminal; config files in a temp
 * HOME. Update: `AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive/config-panel.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.js";
import { plainTheme } from "../../tui.js";
import { cleanupStarted, golden, snapshot, start, started, type Started } from "./test-support.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";

afterEach(async () => {
  setLocale("zh");
  await cleanupStarted();
});

function writeUser(config: object): void {
  started.h!.home.write("home/.config/ama/config.json", { version: 1, ...config });
}

function press(s: Started, key: string): void {
  s.terminal.sendInput(key);
  if (key === ESC) s.terminal.flushInput();
  s.frame();
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function openPanel(s: Started): Promise<void> {
  s.type("/config\r");
  await settle();
  s.frame();
}

describe("/config panel frames", () => {
  it("initial, selection, toggle and summary (80x24)", async () => {
    const s = await start([], { columns: 80, rows: 24 });
    writeUser({ ui: { theme: "light" } });
    await openPanel(s);
    const frames = [snapshot(s.terminal, "config · open")];
    press(s, DOWN);
    frames.push(snapshot(s.terminal, "config · ↓ markdown"));
    press(s, "\r");
    await settle();
    s.frame();
    frames.push(snapshot(s.terminal, "config · markdown toggled"));
    press(s, ESC);
    await settle();
    s.frame();
    frames.push(snapshot(s.terminal, "config · closed with summary"));
    golden("config-80x24", frames.join("\n"));
    const user = JSON.parse(
      readFileSync(join(started.h!.home.configDir, "config.json"), "utf8"),
    ) as { ui: Record<string, unknown> };
    expect(user.ui).toEqual({ theme: "light", markdown: false });
  });

  it("search, Esc clears the search before closing", async () => {
    const s = await start([], { columns: 80, rows: 24 });
    await openPanel(s);
    for (const ch of "/retry") press(s, ch);
    const frames = [snapshot(s.terminal, "config · search retry")];
    press(s, ESC);
    frames.push(snapshot(s.terminal, "config · search cleared"));
    golden("config-search-80x24", frames.join("\n"));
    expect(s.handle.tui.hasOverlay).toBe(true);
    press(s, ESC);
    expect(s.handle.tui.hasOverlay).toBe(false);
  });

  it("project scope, locked rows and the number editor error", async () => {
    const s = await start([], {
      columns: 80,
      rows: 24,
      env: { AMA_CACHE_WARMING: "off" },
    });
    started.h!.home.write("work/.ama/config.json", { version: 1, permission: { mode: "plan" } });
    await openPanel(s);
    for (const ch of "/mode") press(s, ch);
    const frames = [snapshot(s.terminal, "config · user scope, project plan locks mode")];
    press(s, ESC);
    press(s, "\t");
    for (const ch of "/cache") press(s, ch);
    frames.push(snapshot(s.terminal, "config · project scope, cache is user-only"));
    press(s, ESC);
    press(s, "\t");
    for (const ch of "/maxretries") press(s, ch);
    press(s, "\r");
    await settle();
    press(s, "\x7f");
    for (const ch of "lots") press(s, ch);
    press(s, "\r");
    await settle();
    s.frame();
    frames.push(snapshot(s.terminal, "config · number editor error"));
    golden("config-locked-80x24", frames.join("\n"));
  });

  it("narrow (40 columns) and ASCII", async () => {
    const narrow = await start([], { columns: 40, rows: 24 });
    await openPanel(narrow);
    press(narrow, UP);
    golden("config-40x24", snapshot(narrow.terminal, "config · 40 columns, wrapped to last row"));
    press(narrow, ESC);
    await cleanupStarted();
    const ascii = await start([], { columns: 80, rows: 24, theme: plainTheme({ ascii: true }) });
    await openPanel(ascii);
    golden("config-80x24-ascii", snapshot(ascii.terminal, "config · ascii"));
  });

  it("English", async () => {
    setLocale("en");
    const s = await start([], { columns: 80, rows: 24 });
    await openPanel(s);
    golden("config-80x24-en", snapshot(s.terminal, "config · en"));
  });
});
