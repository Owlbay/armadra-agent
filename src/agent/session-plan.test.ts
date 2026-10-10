/**
 * [W5-F] plan 扩展：提醒节奏、plan_state 持久化与恢复、退出提示、子会话不装（docs/history/wave5-plan.md §6.1–§6.3、
 * §6.6）。审批与交接见 session-plan-approval.test.ts。
 */

import { afterEach, describe, expect, it } from "vitest";
import { PermissionPipeline } from "../permissions/pipeline.js";
import { PLAN_MODE_BRIEF, PLAN_MODE_FULL } from "../plan/prompts.js";
import { SessionManager } from "../session/manager.js";
import type { SessionEntry } from "../session/types.js";
import { createPlanExtensionFactory, planController } from "./session-plan.js";
import { AgentSessionImpl } from "./session.js";
import { cleanupPlanDirs, planHarness, tmp } from "./testing/plan-harness.js";

afterEach(cleanupPlanDirs);

/** 每个 user 消息之后紧跟的 plan 相关 custom_message 类型（按回合）。 */
function injectedPerPrompt(branch: readonly SessionEntry[]): string[][] {
  const out: string[][] = [];
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user") out.push([]);
    else if (entry.type === "custom_message" && entry.customType.startsWith("ama.plan"))
      out
        .at(-1)
        ?.push(
          entry.customType === "ama.plan_mode"
            ? entry.content === PLAN_MODE_FULL
              ? "full"
              : entry.content === PLAN_MODE_BRIEF
                ? "brief"
                : "?"
            : entry.customType,
        );
  }
  return out;
}

describe("plan 模式提醒（D18）", () => {
  it("第 1 / 6 / 11 / 16 / 21 个提示提醒（1 完整、其余简版），第 26 个完整版；只追加在 user 消息之后", async () => {
    const h = planHarness(() => ({ text: "ok" }));
    h.session.setPermissionMode("plan");
    for (let i = 0; i < 27; i++) await h.session.prompt(`q${i}`);
    const injected = injectedPerPrompt(h.manager.branch());
    const at = (n: number) => injected[n - 1];
    expect(at(1)).toEqual(["full"]);
    for (const n of [6, 11, 16, 21]) expect(at(n)).toEqual(["brief"]);
    expect(at(26)).toEqual(["full"]);
    const reminded = injected.flatMap((list, i) => (list.length > 0 ? [i + 1] : []));
    expect(reminded).toEqual([1, 6, 11, 16, 21, 26]);
    // display:false，进上下文（投影成 user 消息）
    const request = h.scripted.calls[0]!.context.messages;
    expect(JSON.stringify(request.at(-1))).toContain("Plan mode is active");
  });

  it("压缩后的首个提示补完整版", async () => {
    const h = planHarness(() => ({ text: "ok" }), { mode: "plan" });
    await h.session.prompt("a");
    await h.session.prompt("b");
    await h.session.compact();
    await h.session.prompt("c");
    const injected = injectedPerPrompt(h.manager.branch());
    expect(injected.slice(-3)).toEqual([["full"], [], ["full"]]);
  });

  it("手动退出：下一个提示前追加 plan_mode_exit；plan_state 记 active 与 prePlanMode", async () => {
    const h = planHarness(() => ({ text: "ok" }), { mode: "auto-edit" });
    h.session.setPermissionMode("plan");
    await h.session.prompt("look");
    h.session.setPermissionMode("auto-edit");
    await h.session.prompt("go");
    await h.session.prompt("more");
    const injected = injectedPerPrompt(h.manager.branch());
    expect(injected).toEqual([["full"], ["ama.plan_mode_exit"], []]);
    const states = h.manager
      .branch()
      .flatMap((e) => (e.type === "custom" && e.customType === "ama.plan_state" ? [e.data] : []));
    expect(states).toEqual([
      expect.objectContaining({ active: true, prePlanMode: "auto-edit" }),
      expect.objectContaining({ active: false, prePlanMode: "auto-edit" }),
    ]);
    expect(h.plan.prePlanMode()).toBeUndefined();
  });

  it("会话以 plan 启动：首个提示前补记 plan_state，prePlanMode = default", async () => {
    const h = planHarness(() => ({ text: "ok" }), { mode: "plan" });
    expect(h.plan.prePlanMode()).toBe("default");
    await h.session.prompt("x");
    const state = h.manager.branch().find((e) => e.type === "custom");
    expect(state).toMatchObject({
      customType: "ama.plan_state",
      data: { active: true, prePlanMode: "default" },
    });
  });

  it("resume：plan_state 让会话回到 plan，提醒节奏接着走", async () => {
    const dir = tmp();
    const first = planHarness(() => ({ text: "ok" }), { mode: "auto", dir });
    first.session.setPermissionMode("plan");
    await first.session.prompt("one");
    await first.session.prompt("two");
    const file = first.manager.file()!;
    await first.session.dispose();
    const permission = new PermissionPipeline({ mode: "default", rules: [], cwd: "/work" });
    const resumed = new AgentSessionImpl({
      model: first.model,
      providers: (first.session.options as { providers: AgentSessionImpl["options"]["providers"] })
        .providers,
      sessionManager: SessionManager.open(file),
      permission,
      extensions: [createPlanExtensionFactory({ dataDir: tmp() })],
    });
    expect(permission.mode).toBe("plan");
    expect(resumed.state.permissionMode).toBe("plan");
    expect(planController(resumed)?.prePlanMode()).toBe("auto");
    await resumed.prompt("three");
    const injected = injectedPerPrompt(resumed.manager.branch());
    expect(injected).toEqual([["full"], [], []]);
    await resumed.dispose();
  });

  it("子会话（depth > 0）不装", () => {
    const factory = createPlanExtensionFactory({});
    expect(factory({ core: { depth: 1 } as never })).toBeUndefined();
  });
});
