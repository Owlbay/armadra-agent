/**
 * 第六波命令登记与面板钩子（docs/wave6-plan.md §7 commands 行；[W6-C0]）。
 */

import { describe, expect, it } from "vitest";
import type { AgentSession } from "../agent/types.js";
import type { Runtime } from "../cli/runtime.js";
import {
  BUILTIN_COMMANDS,
  W6_COMMANDS,
  runSlashCommand,
  type CommandContext,
} from "./commands-core.js";
import { PANEL_COMMANDS, runInteractiveCommand, type CommandUi } from "./interactive/commands.js";

const session = { state: { sessionId: "s1" } } as unknown as AgentSession;

function ctx(extra?: CommandContext["extra"]): CommandContext {
  return {
    runtime: {} as Runtime,
    session: () => session,
    switchSession: async () => session,
    ...(extra !== undefined ? { extra } : {}),
  };
}

describe("命令表", () => {
  it("config / trace / memory 登记在内置表尾部", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(names.slice(-3)).toEqual([...W6_COMMANDS]);
  });

  it("line 模式：没有处理器时回「尚未提供」；extra 钩子先于内置分派", async () => {
    expect(await runSlashCommand("/trace", ctx())).toEqual({
      kind: "handled",
      message: "/trace 当前版本尚未提供",
    });
    const seen: string[] = [];
    const result = await runSlashCommand(
      "/memory show prefs",
      ctx({
        memory: async (args) => {
          seen.push(args);
          return { kind: "handled", message: "ok" };
        },
      }),
    );
    expect(result).toEqual({ kind: "handled", message: "ok" });
    expect(seen).toEqual(["show prefs"]);
  });
});

describe("交互模式面板钩子", () => {
  function ui(over: Partial<CommandUi>): { ui: CommandUi; notices: string[]; calls: string[] } {
    const notices: string[] = [];
    const calls: string[] = [];
    const base = {
      runtime: {} as Runtime,
      session: () => session,
      switchSession: async () => session,
      pick: async () => undefined,
      notice: (_level: string, text: string) => void notices.push(text),
      setEditorText: () => undefined,
      prompt: () => undefined,
      reload: () => undefined,
      exit: () => undefined,
      now: () => 0,
    } as unknown as CommandUi;
    return { ui: { ...base, ...over }, notices, calls };
  }

  it("/config /trace /memory 分派到对应钩子", async () => {
    const calls: string[] = [];
    const { ui: u } = ui({
      configPanel: (args) => void calls.push(`config:${args}`),
      traceView: (taskId) => void calls.push(`trace:${taskId ?? "-"}`),
      memoryPanel: (args) => void calls.push(`memory:${args}`),
    });
    for (const line of ["/config ui.theme=light", "/trace", "/trace t2", "/memory reload"])
      expect(await runInteractiveCommand(line, u)).toBe(true);
    expect(calls).toEqual(["config:ui.theme=light", "trace:-", "trace:t2", "memory:reload"]);
  });

  it("没装钩子时回落 commands-core（提示尚未提供）", async () => {
    const { ui: u, notices } = ui({});
    expect(await runInteractiveCommand("/config", u)).toBe(true);
    expect(notices).toEqual(["/config 当前版本尚未提供"]);
  });

  it("/tasks 无参聚焦 Agent 栏，/tasks <id> 进视图，/tasks stop <id> 仍走原命令", async () => {
    const calls: string[] = [];
    const { ui: u } = ui({
      agentBar: () => void calls.push("bar"),
      agentView: (id) => void calls.push(`view:${id}`),
    });
    expect(await PANEL_COMMANDS["tasks"]?.(u, "")).toBe(true);
    expect(await PANEL_COMMANDS["tasks"]?.(u, "t3")).toBe(true);
    expect(await PANEL_COMMANDS["tasks"]?.(u, "stop t3")).toBe(false);
    // [W7-C] `/tasks bg` 不是任务 id：走 commands-core
    expect(await PANEL_COMMANDS["tasks"]?.(u, "bg")).toBe(false);
    expect(calls).toEqual(["bar", "view:t3"]);
    const { ui: plain } = ui({});
    expect(await PANEL_COMMANDS["tasks"]?.(plain, "")).toBe(false);
  });
});

describe("[W7-C] /tasks bg", () => {
  it("无 id：没有阻塞中的任务时不调用、回「没有可转的」；指定 id 调 backgroundTask(id, user)", async () => {
    const calls: unknown[][] = [];
    const bg = {
      state: { sessionId: "s-bg" },
      backgroundTask: (...args: unknown[]) => {
        calls.push(args);
        return args[0] === "t2" ? ["t2"] : [];
      },
    } as unknown as AgentSession;
    const c: CommandContext = {
      runtime: {} as Runtime,
      session: () => bg,
      switchSession: async () => bg,
    };
    expect(await runSlashCommand("/tasks bg", c)).toEqual({
      kind: "handled",
      message: "没有可转后台的前台任务",
    });
    expect(calls).toEqual([]);
    expect(await runSlashCommand("/tasks bg t2", c)).toEqual({
      kind: "handled",
      message: "已转后台：t2，完成后会通知",
    });
    expect(calls).toEqual([["t2", "user"]]);
    await expect(runSlashCommand("/tasks bg t2 extra", c)).rejects.toThrow(/tasks bg/);
  });
});
