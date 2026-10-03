/**
 * `/model` 选择器的交互集成：真实组装根 + fake 供应商 + MemoryTerminal + 临时 HOME 的用户级 config.json。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness } from "../../../test/helpers/compose-harness.js";
import { currentSession } from "../../cli/compose-session.js";
import { cleanupStarted, start, started } from "./test-support.js";

afterEach(cleanupStarted);

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("/model 选择器（交互）", () => {
  it("只见清单内 → Tab 全部 → 选一个 → 写进 models.enabled 并切换", async () => {
    const h = composeHarness([], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: { AMA_SHOW_FAKE: "1" },
    });
    started.h = h;
    const configPath = join(h.home.configDir, "config.json");
    h.home.write(
      configPath,
      `${JSON.stringify({ version: 1, ui: { compact: false }, models: { enabled: ["fake/echo"] } }, null, 2)}\n`,
    );
    const s = await start([], { keepHarness: true });
    s.type("/model");
    s.terminal.sendInput("\r");
    await tick();
    s.frame();
    let screen = s.terminal.viewport().join("\n");
    expect(screen).toContain("╭─ 选择模型");
    expect(screen).toContain("echo");
    expect(screen).not.toContain("reasoning");
    expect(screen).toContain("Tab 全部");

    s.type("\t");
    screen = s.terminal.viewport().join("\n");
    expect(screen).toContain("Tab 已配置");
    expect(screen).toContain("reasoning");
    s.type("reasoning");
    s.terminal.sendInput("\r");
    await tick();
    s.frame();
    expect(currentSession(s.rt).state.model?.id).toBe("reasoning");
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      ui?: unknown;
      models?: { enabled?: string[] };
    };
    expect(written.models?.enabled).toEqual(["fake/echo", "fake/reasoning"]);
    expect(written.ui).toEqual({ compact: false });
    expect(s.rt.config.models?.enabled).toEqual(["fake/echo", "fake/reasoning"]);
    s.handle.exit(0);
    await s.done;
  });

  it("Space 把高亮的模型加入清单（用户级 config.json），已配置视图随之收窄", async () => {
    const s = await start([], { env: { AMA_SHOW_FAKE: "1" } });
    s.type("/model");
    s.terminal.sendInput("\r");
    await tick();
    s.frame();
    expect(s.terminal.viewport().join("\n")).toContain("reasoning");
    s.type(" ");
    expect(s.terminal.viewport().join("\n")).toContain("已把 fake/echo 加入 models.enabled");
    expect(s.terminal.viewport().join("\n")).not.toContain("reasoning");
    const configPath = join(started.h!.home.configDir, "config.json");
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      models?: { enabled?: string[] };
    };
    expect(written.models?.enabled).toEqual(["fake/echo"]);
    s.type("\x1b");
    s.handle.exit(0);
    await s.done;
  });
});
