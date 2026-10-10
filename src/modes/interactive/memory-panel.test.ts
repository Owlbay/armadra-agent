/**
 * `/memory`（docs/history/wave6-plan.md §3.5）：参数解析、行式命令、交互面板（帧黄金）、删除确认、编辑器存回。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.js";
import type { AgentSession } from "../../agent/types.js";
import { memoryOf } from "../../cli/compose-memory.js";
import type { Runtime } from "../../cli/runtime.js";
import type { CommandContext } from "../commands-core.js";
import type { CommandUi } from "./commands.js";
import { createMemoryPanel, memoryLineCommand, parseMemoryArgs } from "./memory-panel.js";
import { cleanupStarted, golden, snapshot, start, started } from "./test-support.js";

afterEach(cleanupStarted);

const press = async (s: Awaited<ReturnType<typeof start>>, key: string): Promise<void> => {
  s.terminal.sendInput(key);
  await new Promise((r) => setTimeout(r, 10));
  s.frame();
};
const screen = (s: Awaited<ReturnType<typeof start>>): string => s.terminal.viewport().join("\n");

/** 直接写条目文件（固定 updated，帧与日期无关）。 */
function seed(dataDir: string): void {
  const dir = join(dataDir, "memory", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "prefers-pnpm.md"),
    "---\nname: prefers-pnpm\ndescription: 用 pnpm 不用 npm\ntype: user\nupdated: 2026-10-01\n---\n\n用 pnpm。\n",
  );
  writeFileSync(
    join(dir, "old-style.md"),
    "---\nname: old-style\ndescription: 旧的代码风格约定\ntype: feedback\nupdated: 2025-01-02\n---\n\n两空格缩进。\n",
  );
}

describe("参数", () => {
  it.each([
    ["", { kind: "list" }],
    ["list", { kind: "list" }],
    ["show pnpm", { kind: "show", name: "pnpm" }],
    ["show", { kind: "usage" }],
    ["edit", { kind: "edit" }],
    ["edit project", { kind: "edit", target: "project" }],
    ["rm a b", { kind: "rm", name: "a b", yes: false }],
    ["rm a --yes", { kind: "rm", name: "a", yes: true }],
    ["on", { kind: "writes", on: true }],
    ["off", { kind: "writes", on: false }],
    ["reload", { kind: "reload" }],
    ["reload now", { kind: "usage" }],
    ["frobnicate", { kind: "usage" }],
  ])("%j", (args, action) => {
    expect(parseMemoryArgs(args)).toEqual(action);
  });
});

describe("行式命令", () => {
  it("未开启时提示如何开启；开启后 list / show / rm（需 --yes）/ on|off / reload / edit", async () => {
    const s = await start([], { argv: ["--memory"] });
    const session = s.handle.session();
    const ctx = { runtime: s.rt, session: () => session } as unknown as CommandContext;
    seed(started.h!.home.env["AMA_DATA_DIR"]!);
    const run = async (args: string) =>
      ((await memoryLineCommand(args, ctx)) as { message: string }).message;
    expect(await run("")).toContain("用户 /memories/user/ · 2 条");
    expect(await run("")).toContain("old-style [old-style.md] — 旧的代码风格约定");
    expect(await run("")).toContain("超过 90 天未更新");
    expect(await run("show pnpm")).toBe("没有名为 pnpm 的记忆");
    expect(await run("show prefers-pnpm")).toContain("/memories/user/prefers-pnpm.md\n---");
    expect(await run("rm old-style")).toBe("确认删除请加 --yes：/memory rm old-style --yes");
    expect(await run("rm old-style --yes")).toBe(
      "已删除 /memories/user/old-style.md，下次会话起不再出现在索引。",
    );
    expect(await run("off")).toBe("本会话禁止写入记忆。");
    expect(memoryOf(session)!.writesEnabled).toBe(false);
    expect(await run("")).toContain("本会话禁止写入记忆（/memory on 恢复）");
    expect(await run("on")).toBe("本会话允许写入记忆（每次写入仍需审批）。");
    expect(await run("reload")).toContain("已重读记忆索引");
    expect(await run("reload")).toBe("记忆索引没有变化。");
    expect(await run("edit")).toContain("ama memory edit");
    expect(await run("x")).toContain("用法：/memory");
    s.handle.exit(0);
    await s.done;
  });

  it("会话未开启记忆", async () => {
    const s = await start([]);
    const session = s.handle.session();
    const ctx = { runtime: s.rt, session: () => session } as unknown as CommandContext;
    const out = (await memoryLineCommand("", ctx)) as { message: string };
    expect(out.message).toContain("记忆未开启");
    s.handle.exit(0);
    await s.done;
  });
});

describe("交互面板", () => {
  it("/memory 面板 80x24（超过 90 天的条目标灰）", async () => {
    const s = await start([], { argv: ["--memory", "--trust"], quietStartup: "silent" });
    seed(started.h!.home.env["AMA_DATA_DIR"]!);
    s.type("/memory");
    await press(s, "\r");
    golden("memory-panel-80x24", snapshot(s.terminal, "/memory"));
    s.handle.exit(0);
    await s.done;
  });

  it("/memory 面板 40x24", async () => {
    const s = await start([], {
      argv: ["--memory"],
      quietStartup: "silent",
      columns: 40,
    });
    seed(started.h!.home.env["AMA_DATA_DIR"]!);
    s.type("/memory");
    await press(s, "\r");
    golden("memory-panel-40x24", snapshot(s.terminal, "/memory"));
    s.handle.exit(0);
    await s.done;
  });

  it("/memory rm：确认框取消不删、y 删除", async () => {
    const s = await start([], { argv: ["--memory"] });
    const dataDir = started.h!.home.env["AMA_DATA_DIR"]!;
    seed(dataDir);
    const file = join(dataDir, "memory", "user", "old-style.md");
    s.type("/memory rm old-style");
    await press(s, "\r");
    expect(screen(s)).toContain("删除这条记忆？");
    expect(screen(s)).toContain("/memories/user/old-style.md");
    await press(s, "\x1b");
    expect(existsSync(file)).toBe(true);
    s.type("/memory rm old-style");
    await press(s, "\r");
    await press(s, "y");
    expect(existsSync(file)).toBe(false);
    expect(screen(s)).toContain("已删除 /memories/user/old-style.md");
    s.handle.exit(0);
    await s.done;
  });

  it("/memory edit：编辑器副本存回（凭据拒写给本地化提示）；新条目按 name 起文件名", async () => {
    const s = await start([], { argv: ["--memory"] });
    seed(started.h!.home.env["AMA_DATA_DIR"]!);
    const session = s.handle.session();
    const notices: string[] = [];
    const ui = {
      runtime: s.rt as Runtime,
      session: () => session as AgentSession,
      notice: (_level: string, text: string) => notices.push(text),
      now: () => Date.now(),
    } as unknown as CommandUi;
    let next = "";
    const panel = createMemoryPanel({
      ui: () => ui,
      choice: { theme: undefined as never, showOverlay: () => undefined as never },
      suspend: () => undefined,
      resume: () => undefined,
      env: {},
      edit: async (text) => (next === "" ? undefined : next.replace("$TEXT", text)),
    });
    await panel("edit prefers-pnpm");
    expect(notices.pop()).toBe("编辑器未保存退出，没有改动。");
    next = "$TEXT\n补充：CI 也用 pnpm。";
    await panel("edit prefers-pnpm");
    expect(notices.pop()).toBe("已保存 /memories/user/prefers-pnpm.md，下次会话起出现在索引。");
    expect(memoryOf(session)!.store.readRaw({ scope: "user", file: "prefers-pnpm.md" })).toContain(
      "补充：CI 也用 pnpm。",
    );
    next = "$TEXT\ntoken: ghp_abcdefghijklmnopqrstuvwxyz0123";
    await panel("edit prefers-pnpm");
    expect(notices.pop()).toBe("看起来像凭据（GitHub token），未保存。");
    next = "---\nname: Test DB Reset\ndescription: 测试前重置\n---\n\npnpm db:reset";
    await panel("edit user");
    expect(notices.pop()).toBe("已保存 /memories/user/test-db-reset.md，下次会话起出现在索引。");
    await panel("show nothing");
    expect(notices.pop()).toBe("没有名为 nothing 的记忆");
    s.handle.exit(0);
    await s.done;
  });
});

describe("交互面板（en）", () => {
  afterEach(() => setLocale("zh"));
  it("/memory 面板 80x24", async () => {
    setLocale("en");
    const s = await start([], { argv: ["--memory", "--trust"], quietStartup: "silent" });
    const dir = join(started.h!.home.env["AMA_DATA_DIR"]!, "memory", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "prefers-pnpm.md"),
      "---\nname: prefers-pnpm\ndescription: use pnpm, not npm\ntype: user\nupdated: 2026-10-01\n---\n\nUse pnpm.\n",
    );
    writeFileSync(
      join(dir, "old-style.md"),
      "---\nname: old-style\ndescription: old code style rules\ntype: feedback\nupdated: 2025-01-02\n---\n\nTwo-space indent.\n",
    );
    s.type("/memory");
    await press(s, "\r");
    golden("en/memory-panel-80x24", snapshot(s.terminal, "/memory"));
    s.handle.exit(0);
    await s.done;
  });
});
