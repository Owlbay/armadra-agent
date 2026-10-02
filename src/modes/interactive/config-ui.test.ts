import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import { currentSession } from "../../cli/compose-session.js";
import type { Runtime } from "../../cli/runtime.js";
import { parseArgs } from "../../cli/args.js";
import type { ModeContext } from "../../cli/deps.js";
import { runSlashCommand } from "../commands-core.js";
import { applySetting, configCommand, splitAssignment } from "./config-ui.js";
import { cleanupStarted, start, started, type Started } from "./test-support.js";

afterEach(async () => {
  await cleanupStarted();
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function slash(s: Started, line: string): Promise<void> {
  s.type(`${line}\r`);
  await settle();
  await settle();
  s.frame();
}

const userConfig = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(started.h!.home.configDir, "config.json"), "utf8")) as Record<
    string,
    unknown
  >;

const viewText = (s: Started): string => s.terminal.viewport().join("\n");

describe("/config key=value (interactive)", () => {
  it("writes the user config, switches the session and hands /new the new config", async () => {
    const s = await start([], { columns: 80, rows: 24 });
    await slash(s, "/config thinkingLevel=low");
    expect(s.handle.session().state.thinkingLevel).toBe("low");
    expect(userConfig()["thinkingLevel"]).toBe("low");
    expect(viewText(s)).toContain("thinkingLevel = low（用户级）");
    await slash(s, "/config compaction.reserveTokens 1234");
    expect(s.rt.config.compaction?.reserveTokens).toBe(1234);
    await slash(s, "/config defaultModel=fake/reasoning");
    expect(s.handle.session().state.model).toEqual({ provider: "fake", id: "reasoning" });
    await slash(s, "/config ui.statusLine=full");
    expect(s.handle.area.layout()).toBe("full");
    await slash(s, "/config nope.key=1");
    expect(viewText(s)).toContain("nope.key 不是可设置项");
    await slash(s, "/config ui.theme=neon");
    expect(viewText(s)).toContain("ui.theme：应为 dark | light | auto 之一，收到 neon");
  });

  it("persisting full-auto goes through the Bypass confirmation", async () => {
    const s = await start([], { columns: 80, rows: 24 });
    s.type("/config permission.mode=full-auto\r");
    await settle();
    s.frame();
    expect(viewText(s)).toContain("以后每次启动都在 Bypass permissions 下运行");
    s.type("n");
    await settle();
    await settle();
    expect(s.handle.session().state.permissionMode).toBe("default");
    s.type("/config permission.mode=full-auto\r");
    await settle();
    s.type("y");
    await settle();
    await settle();
    expect(userConfig()["permission"]).toEqual({ mode: "full-auto" });
    expect(s.handle.session().state.permissionMode).toBe("full-auto");
  });
});

describe("/config panel hot apply", () => {
  it("toggles apply to the view and session; prefix notice once a reply exists", async () => {
    const s = await start([{ text: "hi" }], { columns: 80, rows: 24 });
    s.type("hello\r");
    await s.until((e) => e.type === "agent_settled");
    s.type("/config\r");
    await settle();
    for (const ch of "/showthinking") s.type(ch);
    s.type("\r");
    await settle();
    s.frame();
    expect(userConfig()["ui"]).toEqual({ showThinking: "hidden" });
    s.type("\x1b");
    s.terminal.flushInput();
    for (const ch of "/thinkingLevel") s.type(ch);
    s.type("\r");
    await settle();
    s.type("\x1b[A");
    s.type("\r");
    await settle();
    await settle();
    s.frame();
    expect(viewText(s)).toContain("会改变缓存前缀");
    expect(s.handle.session().state.thinkingLevel).toBe("low");
  });

  it("applySetting covers the now-tier keys", async () => {
    const calls: unknown[] = [];
    const session = {
      setThinkingLevel: (v: unknown) => calls.push(["thinking", v]),
      setPermissionMode: (v: unknown) => calls.push(["mode", v]),
      setModel: async (v: unknown) => void calls.push(["model", v]),
    };
    const targets = {
      session: () => session as never,
      view: { setOptions: (o: unknown) => calls.push(["view", o]) },
      loader: { setAnimation: (on: boolean) => calls.push(["animation", on]) },
      area: { setLayout: (m: unknown) => calls.push(["layout", m]) },
      redraw: () => calls.push("redraw"),
    };
    expect(await applySetting("ui.compact", true, targets)).toBe(true);
    expect(await applySetting("ui.markdown", undefined, targets)).toBe(true);
    expect(await applySetting("ui.animation", false, targets)).toBe(true);
    expect(await applySetting("ui.statusLine", "compact", targets)).toBe(true);
    expect(await applySetting("thinkingLevel", "high", targets)).toBe(true);
    expect(await applySetting("permission.mode", "plan", targets)).toBe(true);
    expect(await applySetting("defaultModel", "fake/echo", targets)).toBe(true);
    expect(await applySetting("ui.theme", "light", targets)).toBe(false);
    expect(calls).toEqual([
      ["view", { compact: true }],
      "redraw",
      ["view", { markdown: true }],
      "redraw",
      ["animation", false],
      "redraw",
      ["layout", "compact"],
      "redraw",
      ["thinking", "high"],
      ["mode", "plan"],
      ["model", "fake/echo"],
    ]);
  });
});

describe("line mode /config", () => {
  let h: ComposeHarness | undefined;
  let rt: Runtime | undefined;
  afterEach(async () => {
    await rt?.dispose();
    h?.cleanup();
  });

  it("lists, sets and refuses", async () => {
    h = composeHarness();
    rt = await h.boot(["--model", "fake/echo"]);
    const parsed = parseArgs(["--model", "fake/echo"]);
    if (parsed.kind !== "run") throw new Error("run");
    const context: ModeContext = { args: parsed.args, prompt: undefined, io: h.io };
    const runtime = rt;
    const ctx = {
      runtime,
      session: () => currentSession(runtime),
      switchSession: () => Promise.reject(new Error("unused")),
      extra: { config: configCommand(runtime, context) },
    };
    const list = await runSlashCommand("/config", ctx);
    expect(list).toMatchObject({ kind: "handled" });
    expect((list as { message: string }).message).toContain("ui.theme = dark  default");
    const set = await runSlashCommand("/config retry.enabled=false", ctx);
    expect((set as { message: string }).message).toBe("retry.enabled = false（用户级）");
    const bypass = await runSlashCommand("/config permission.mode=full-auto", ctx);
    expect((bypass as { message: string }).message).toContain("--yes");
    const bad = await runSlashCommand("/config retry.maxRetries=-1", ctx);
    expect((bad as { message: string }).message).toContain("retry.maxRetries");
    const config = JSON.parse(readFileSync(join(h.home.configDir, "config.json"), "utf8"));
    expect(config.retry).toEqual({ enabled: false });
    expect(config.permission).toBeUndefined();
  });

  it("splits key=value and key value", () => {
    expect(splitAssignment("a.b=1")).toEqual(["a.b", "1"]);
    expect(splitAssignment(" a.b  two words ")).toEqual(["a.b", "two words"]);
    expect(splitAssignment("x=a=b")).toEqual(["x", "a=b"]);
    expect(splitAssignment("lonely")).toBeUndefined();
  });
});
