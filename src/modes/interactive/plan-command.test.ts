import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, PlanData } from "../../agent/types.js";
import type { PermissionMode } from "../../permissions/types.js";
import {
  planController,
  registerPlanController,
  type PlanController,
  type PlanResponse,
  type PlanResponseResult,
} from "../../plan/controller.js";
import { plainTheme } from "../../tui.js";
import { planPanel } from "./agent-panels.js";
import { describePlan, planCommand, planTitle } from "./plan-command.js";
import { PlanFlow } from "./plan-flow.js";
import type { PlanChoice } from "./plan-dialog.js";
import { lines } from "./test-support.js";

const PLAN: PlanData = {
  id: "p1",
  version: 2,
  status: "proposed",
  markdown: "# 加回退显示\n\n## 步骤\n- [ ] S1 读代码\n- [ ] S2 改状态栏",
  steps: [
    { id: "S1", text: "读代码" },
    { id: "S2", text: "改状态栏" },
  ],
  sourceEntryId: "e1",
  filePath: "/data/plans/s-v2.md",
};

interface FakeSession {
  session: AgentSession;
  responses: PlanResponse[];
  adopted: PlanData[];
  modes: PermissionMode[];
}

function fakeSession(
  options: {
    plan?: PlanData | null;
    mode?: PermissionMode;
    pre?: PermissionMode;
    id?: string;
  } = {},
): FakeSession {
  const state = {
    permissionMode: options.mode ?? "plan",
    sessionId: options.id ?? "s1",
    isStreaming: false,
  };
  const modes: PermissionMode[] = [];
  const session = {
    state,
    setPermissionMode(mode: PermissionMode) {
      state.permissionMode = mode;
      modes.push(mode);
    },
  } as unknown as AgentSession;
  const responses: PlanResponse[] = [];
  const adopted: PlanData[] = [];
  let plan = options.plan === undefined ? PLAN : options.plan;
  const controller: PlanController = {
    current: () => plan,
    get: () => plan,
    pending: () => (plan?.status === "proposed" ? plan : undefined),
    todos: () => [
      { id: "S1", text: "读代码", status: "done" },
      { id: "S2", text: "改状态栏", status: "in_progress" },
    ],
    prePlanMode: () => (state.permissionMode === "plan" ? (options.pre ?? "default") : undefined),
    async respond(response): Promise<PlanResponseResult> {
      responses.push(response);
      const current = plan as PlanData;
      const approved = { ...current, status: "approved" as const };
      if (response.decision === "reject") plan = { ...current, status: "rejected" };
      if (response.decision === "approve" || response.decision === "approve_fresh") plan = approved;
      return {
        planId: current.id,
        decision: response.decision,
        ...(response.mode !== undefined ? { mode: response.mode } : {}),
        plan: response.decision === "reject" ? { ...current, status: "rejected" } : approved,
        ...(response.decision === "approve_fresh" ? { freshPrompt: "按计划执行：…" } : {}),
      };
    },
    proposeFromLastReply: () => plan ?? undefined,
    adopt: (p) => void adopted.push(p),
    setAttendance: () => undefined,
  };
  registerPlanController(session, controller);
  return { session, responses, adopted, modes };
}

const cleanup: AgentSession[] = [];
afterEach(() => {
  for (const s of cleanup.splice(0)) registerPlanController(s, undefined);
});

function track(f: FakeSession): FakeSession {
  cleanup.push(f.session);
  return f;
}

const ctx = (next?: AgentSession) => ({
  switchSession: async () => next ?? fakeSession({ mode: "default" }).session,
});

describe("/plan 命令（line 与交互共用）", () => {
  it("planTitle 取第一个标题", () => {
    expect(planTitle(PLAN)).toBe("加回退显示");
    expect(planTitle({ markdown: "<proposed_plan>\n先做 A\n" })).toBe("先做 A");
  });

  it("/plan 显示版本、状态、文件、步骤与待办", async () => {
    const f = track(fakeSession());
    const result = await planCommand(f.session, "", ctx());
    expect(result).toEqual({ kind: "handled", message: describePlan(controllerOf(f), f.session) });
    const text = (result as { message: string }).message;
    expect(text).toContain("计划 v2 · 待审批 · 加回退显示");
    expect(text).toContain("文件：/data/plans/s-v2.md");
    expect(text).toContain("模式：Plan（批准后回到 Manual）");
    expect(text).toContain("  S2 改状态栏");
    expect(text).toContain("待办：1/2 完成 · 进行中 改状态栏");
    expect(text).toContain("/plan approve [模式|fresh]");
  });

  it("没有计划时的说明", async () => {
    const outside = track(fakeSession({ plan: null, mode: "default" }));
    expect(await planCommand(outside.session, "", ctx())).toMatchObject({
      message: "没有计划。/plan <目标> 进入 Plan 模式",
    });
    const inside = track(fakeSession({ plan: null }));
    expect(
      ((await planCommand(inside.session, "", ctx())) as { message: string }).message,
    ).toContain("还没有计划");
  });

  it("/plan approve 缺省回到进入前的模式；带模式名", async () => {
    const f = track(fakeSession({ pre: "auto-edit" }));
    expect(await planCommand(f.session, "approve", ctx())).toEqual({
      kind: "handled",
      message: "已批准计划 v2，以 Accept edits 执行",
      wait: true,
    });
    expect(f.responses).toEqual([{ planId: "p1", decision: "approve", mode: "auto-edit" }]);
    const g = track(fakeSession());
    await planCommand(g.session, "approve auto", ctx());
    expect(g.responses[0]?.mode).toBe("auto");
    await expect(planCommand(track(fakeSession()).session, "approve plan", ctx())).rejects.toThrow(
      "执行模式无效",
    );
  });

  it("/plan approve fresh：新会话 adopt、切执行模式、发首条消息", async () => {
    const f = track(fakeSession());
    const next = track(fakeSession({ mode: "default", id: "s2", plan: null }));
    const result = await planCommand(f.session, "approve fresh", ctx(next.session));
    expect(result).toEqual({ kind: "prompt", text: "按计划执行：…" });
    expect(f.responses[0]).toMatchObject({ decision: "approve_fresh", mode: "default" });
    expect(next.adopted.map((p) => p.status)).toEqual(["approved"]);
    expect(next.modes).toEqual(["default"]);
  });

  it("/plan reject；没有待审批的计划时报错", async () => {
    const f = track(fakeSession());
    expect(await planCommand(f.session, "reject", ctx())).toEqual({
      kind: "handled",
      message: "已放弃计划 v2（仍在 Plan 模式）",
    });
    await expect(planCommand(f.session, "reject", ctx())).rejects.toThrow("没有待审批的计划");
  });

  it("/plan <目标> 进入 Plan 模式并发出目标", async () => {
    const f = track(fakeSession({ mode: "default", plan: null }));
    expect(await planCommand(f.session, "给状态栏加回退显示", ctx())).toEqual({
      kind: "prompt",
      text: "给状态栏加回退显示",
    });
    expect(f.modes).toEqual(["plan"]);
  });

  it("/plan 面板（交互模式）", () => {
    const f = track(fakeSession());
    const out = lines(planPanel(controllerOf(f), f.session, plainTheme()), 70);
    expect(out[0]).toBe("▎ 计划 v2  /data/plans/s-v2.md");
    expect(out.join("\n")).toContain("状态  待审批");
    expect(out.join("\n")).toContain("S2 改状态栏");
  });
});

function controllerOf(f: FakeSession): PlanController {
  return planController(f.session) as PlanController;
}

describe("PlanFlow（审批框 → respond）", () => {
  function flow(choice: PlanChoice, next?: AgentSession) {
    const notices: string[] = [];
    const prompts: string[] = [];
    const flow = new PlanFlow({
      dialog: {
        theme: plainTheme(),
        showOverlay: () => ({ hide() {}, focus() {}, visible: true }),
      },
      switchSession: async () => next ?? fakeSession({ mode: "default" }).session,
      notice: (_level, text) => void notices.push(text),
      prompt: (text) => void prompts.push(text),
      open: async () => choice,
    });
    return { flow, notices, prompts };
  }

  it("批准：respond approve 带模式与编辑后的全文", async () => {
    const f = track(fakeSession());
    const t = flow({ decision: "approve", mode: "auto", editedMarkdown: "# 新\n- [ ] S1 x" });
    await t.flow.ask(f.session, PLAN);
    expect(f.responses).toEqual([
      { planId: "p1", decision: "approve", mode: "auto", editedMarkdown: "# 新\n- [ ] S1 x" },
    ]);
    expect(t.notices).toEqual(["已批准计划 v2，以 Auto 执行"]);
  });

  it("新上下文执行：先新建会话、adopt，再发首条消息", async () => {
    const f = track(fakeSession());
    const next = track(fakeSession({ mode: "default", id: "s2abcdef9", plan: null }));
    const t = flow({ decision: "approve_fresh", mode: "auto-edit" }, next.session);
    await t.flow.ask(f.session, PLAN);
    expect(next.adopted).toHaveLength(1);
    expect(next.modes).toEqual(["auto-edit"]);
    expect(t.prompts).toEqual(["按计划执行：…"]);
    expect(t.notices[0]).toContain("在新会话 s2abcdef 以 Accept edits 执行");
  });

  it("继续修改：意见交给 respond revise", async () => {
    const f = track(fakeSession());
    const t = flow({ decision: "revise", feedback: "拆细" });
    await t.flow.ask(f.session, PLAN);
    expect(f.responses).toEqual([{ planId: "p1", decision: "revise", feedback: "拆细" }]);
  });

  it("放弃：4 退出 Plan 模式回到进入前的模式；Esc 留在 Plan", async () => {
    const f = track(fakeSession({ pre: "auto" }));
    await flow({ decision: "reject", exit: true }).flow.ask(f.session, PLAN);
    expect(f.responses[0]?.decision).toBe("reject");
    expect(f.modes).toEqual(["auto"]);
    const g = track(fakeSession());
    const t = flow({ decision: "reject", exit: false });
    await t.flow.ask(g.session, PLAN);
    expect(g.modes).toEqual([]);
    expect(t.notices[0]).toContain("仍在 Plan 模式");
  });

  it("attach：接管审批（callback），已有待审批的计划提示一行", () => {
    const f = track(fakeSession());
    const kinds: string[] = [];
    controllerOf(f).setAttendance = (kind) => void kinds.push(kind);
    const t = flow({ decision: "reject", exit: false });
    t.flow.attach(f.session);
    expect(kinds).toEqual(["callback"]);
    expect(t.notices).toEqual(["计划 v2 待审批：/plan 打开审批框"]);
  });
});
