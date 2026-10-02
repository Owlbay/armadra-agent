/**
 * [W5-F] 计划提取、审批编排与交接（docs/wave5-plan.md §6.1、§6.3、§6.6）：
 * 无人值守 stop / approve、客户端回答（批准 / 拒绝 / 修改 / 编辑 / 新上下文）、交互文本回复、SDK 回调。
 */

import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptStep } from "./testing/scripted-api.js";
import { cleanupPlanDirs, planHarness, tmp } from "./testing/plan-harness.js";
import { userTexts } from "./testing/harness.js";
import type { SessionEntry } from "../session/types.js";

afterEach(cleanupPlanDirs);

const PLAN_REPLY = [
  "I looked around.",
  "<proposed_plan>",
  "# Fix it",
  "## Steps",
  "- [ ] S1 Read src/a.ts",
  "- [ ] S2 Patch the bug [depends: S1]",
  "## Verification",
  "- pnpm test",
  "</proposed_plan>",
].join("\n");

function customs(branch: readonly SessionEntry[], type: string): unknown[] {
  return branch.flatMap((e) => (e.type === "custom" && e.customType === type ? [e.data] : []));
}

function customMessages(branch: readonly SessionEntry[]): string[] {
  return branch.flatMap((e) => (e.type === "custom_message" ? [e.customType] : []));
}

const settle = async (h: { session: { waitForIdle(): Promise<void> } }): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1));
    await h.session.waitForIdle();
  }
};

describe("提取与无人值守（plan.unattended）", () => {
  it("stop（缺省）：落 ama.plan{proposed} 与文件、发 plan_proposed，留在 plan，不替人批准", async () => {
    const dataDir = tmp();
    const h = planHarness([{ text: PLAN_REPLY }], { mode: "plan", dataDir });
    await h.session.prompt("plan a fix");
    await settle(h);
    const proposed = h.events.find((e) => e.type === "plan_proposed");
    expect(proposed).toMatchObject({
      version: 1,
      steps: [
        { id: "S1", text: "Read src/a.ts" },
        { id: "S2", text: "Patch the bug", dependsOn: ["S1"] },
      ],
    });
    const plan = h.plan.pending()!;
    expect(plan.status).toBe("proposed");
    expect(plan.filePath).toBe(proposed?.type === "plan_proposed" ? proposed.filePath : "");
    expect(plan.filePath?.startsWith(dataDir)).toBe(true);
    expect(readFileSync(plan.filePath!, "utf8")).toContain("# Fix it");
    expect(h.permission.mode).toBe("plan");
    expect(h.scripted.calls).toHaveLength(1);
    expect(customs(h.manager.branch(), "ama.todo")).toEqual([]);
  });

  it("approve：同一 run 内交接——切回进入前模式、todo、plan_approved、执行回合", async () => {
    const script: ScriptStep[] = [{ text: PLAN_REPLY }, { text: "executing" }];
    const h = planHarness(script, { mode: "auto-edit", config: { unattended: "approve" } });
    h.session.setPermissionMode("plan");
    await h.session.prompt("plan a fix");
    await settle(h);
    expect(h.permission.mode).toBe("auto-edit");
    expect(h.scripted.calls).toHaveLength(2);
    const last = userTexts(h.scripted.calls[1]!.context).at(-1)!;
    expect(last).toContain("<approved_plan>");
    expect(last).toContain("Plan mode has ended");
    expect(customs(h.manager.branch(), "ama.todo").at(-1)).toEqual({
      items: [
        { id: "S1", text: "Read src/a.ts", status: "in_progress", planStep: "S1" },
        { id: "S2", text: "Patch the bug", status: "pending", planStep: "S2" },
      ],
    });
    expect(h.plan.current()?.status).toBe("approved");
    const types = h.types();
    expect(types.indexOf("plan_proposed")).toBeLessThan(types.indexOf("plan_resolved"));
    expect(types).toContain("todo_updated");
    expect(h.events.find((e) => e.type === "plan_resolved")).toMatchObject({
      decision: "approve",
      mode: "auto-edit",
    });
    // 获批交接不再追加 plan_mode_exit（交接消息里已说明）
    expect(customMessages(h.manager.branch())).toEqual(["ama.plan_mode", "ama.plan_approved"]);
  });

  it("没有计划块：什么也不做；子会话里的计划块不提取（扩展只装在根会话）", async () => {
    const h = planHarness([{ text: "Just a question?" }], { mode: "plan" });
    await h.session.prompt("hi");
    expect(h.plan.current()).toBeNull();
    expect(h.types()).not.toContain("plan_proposed");
  });
});

describe("客户端回答（attendance: client）", () => {
  const proposed = async (script: ScriptStep[], mode: "plan" | "default" = "default") => {
    const h = planHarness(script, { mode, attendance: "client" });
    if (mode !== "plan") h.session.setPermissionMode("plan");
    await h.session.prompt("plan it");
    await settle(h);
    return { h, plan: h.plan.pending()! };
  };

  it("approve：空闲时开新回合（user 消息 origin=plan + plan_approved），执行模式回到进入前", async () => {
    const { h, plan } = await proposed([{ text: PLAN_REPLY }, { text: "done" }]);
    const result = await h.plan.respond({ planId: plan.id, decision: "approve" });
    await settle(h);
    expect(result).toMatchObject({ planId: plan.id, decision: "approve", mode: "default" });
    expect(h.permission.mode).toBe("default");
    const texts = userTexts(h.scripted.calls[1]!.context);
    expect(texts.at(-2)).toBe("The plan is approved. Go ahead.");
    expect(texts.at(-1)).toContain("# Fix it");
    const user = h.manager
      .branch()
      .filter((e) => e.type === "message" && e.message.role === "user")
      .at(-1);
    expect(user).toMatchObject({ message: { origin: "plan" } });
    expect(h.plan.todos().map((t) => t.status)).toEqual(["in_progress", "pending"]);
  });

  it("approve 指定模式；进入前就是 plan 时缺省用 default", async () => {
    const { h, plan } = await proposed([{ text: PLAN_REPLY }, { text: "done" }], "plan");
    expect(h.plan.prePlanMode()).toBe("default");
    await h.plan.respond({ planId: plan.id, decision: "approve", mode: "auto" });
    await settle(h);
    expect(h.permission.mode).toBe("auto");
  });

  it("reject：标 rejected，留在 plan；再回答报 plan_not_found", async () => {
    const { h, plan } = await proposed([{ text: PLAN_REPLY }]);
    await h.plan.respond({ planId: plan.id, decision: "reject" });
    expect(h.plan.current()?.status).toBe("rejected");
    expect(h.permission.mode).toBe("plan");
    await expect(h.plan.respond({ planId: plan.id, decision: "approve" })).rejects.toMatchObject({
      code: "plan_not_found",
    });
  });

  it("revise：意见作为普通 user 消息，留在 plan；新计划把旧版标 superseded、版本 +1", async () => {
    const revised = PLAN_REPLY.replace("# Fix it", "# Fix it v2");
    const { h, plan } = await proposed([{ text: PLAN_REPLY }, { text: revised }]);
    await h.plan.respond({ planId: plan.id, decision: "revise", feedback: "also add docs" });
    await settle(h);
    expect(userTexts(h.scripted.calls[1]!.context)).toContain("also add docs");
    expect(h.permission.mode).toBe("plan");
    const next = h.plan.pending()!;
    expect(next).toMatchObject({ id: plan.id, version: 2 });
    expect(next.markdown).toContain("v2");
    const statuses = customs(h.manager.branch(), "ama.plan").map(
      (p) => (p as { status: string }).status,
    );
    expect(statuses).toEqual(["proposed", "superseded", "proposed"]);
  });

  it("editedMarkdown：版本 +1、步骤按编辑后全文，交接用编辑后全文", async () => {
    const { h, plan } = await proposed([{ text: PLAN_REPLY }, { text: "ok" }]);
    const edited = "# Edited\n## Steps\n1. only step";
    const result = await h.plan.respond({
      planId: plan.id,
      decision: "approve",
      editedMarkdown: edited,
    });
    await settle(h);
    expect(result.plan).toMatchObject({ version: 2, status: "approved", markdown: edited });
    expect(h.plan.todos()).toEqual([
      { id: "S1", text: "only step", status: "in_progress", planStep: "S1" },
    ]);
    expect(userTexts(h.scripted.calls[1]!.context).at(-1)).toContain("# Edited");
    expect(existsSync(result.plan.filePath!)).toBe(true);
  });

  it("approve_fresh：本会话标 approved 并切模式，返回新会话首条消息；adopt 在新会话生成 todo", async () => {
    const { h, plan } = await proposed([{ text: PLAN_REPLY }]);
    const result = await h.plan.respond({ planId: plan.id, decision: "approve_fresh" });
    expect(result.freshPrompt).toContain("# Fix it");
    expect(h.scripted.calls).toHaveLength(1);
    expect(h.permission.mode).toBe("default");
    expect(h.plan.todos()).toEqual([]);
    const other = planHarness([{ text: "ok" }]);
    other.plan.adopt(result.plan);
    expect(other.plan.todos()).toHaveLength(2);
    expect(other.plan.current()?.status).toBe("approved");
  });
});

describe("交互文本回复与 SDK 回调", () => {
  it("text：待审批时回复 2 = 以 Accept edits 批准，同一提示后追加交接；提示行只发事件不落盘", async () => {
    const h = planHarness([{ text: PLAN_REPLY }, { text: "go" }], {
      mode: "plan",
      attendance: "text",
      notice: true,
    });
    await h.session.prompt("plan");
    const notice = h.events.find(
      (e) =>
        e.type === "message_start" &&
        e.message.role === "custom" &&
        e.message.customType === "ama.plan_notice",
    );
    expect(JSON.stringify(notice)).toContain("回复 1 批准并执行");
    expect(customMessages(h.manager.branch())).not.toContain("ama.plan_notice");
    await h.session.prompt("2");
    expect(h.permission.mode).toBe("auto-edit");
    const texts = userTexts(h.scripted.calls[1]!.context);
    expect(texts.at(-2)).toBe("2");
    expect(texts.at(-1)).toContain("<approved_plan>");
  });

  it("text：其它回复是修改意见，留在 plan", async () => {
    const h = planHarness([{ text: PLAN_REPLY }, { text: "revised" }], {
      mode: "plan",
      attendance: "text",
    });
    await h.session.prompt("plan");
    await h.session.prompt("please also cover docs");
    expect(h.permission.mode).toBe("plan");
    expect(h.plan.pending()?.status).toBe("proposed");
  });

  it("callback：SDK onProposed 的回答在运行结束后生效", async () => {
    const seen: string[] = [];
    const h = planHarness([{ text: PLAN_REPLY }, { text: "go" }], { mode: "plan" });
    h.plan.setAttendance("callback", async (plan) => {
      seen.push(plan.markdown.split("\n")[0]!);
      return { decision: "approve", mode: "auto-edit" };
    });
    await h.session.prompt("plan");
    await settle(h);
    expect(seen).toEqual(["# Fix it"]);
    expect(h.permission.mode).toBe("auto-edit");
    expect(h.scripted.calls).toHaveLength(2);
  });

  it("proposeFromLastReply：没有计划块时把上一条回复当作计划", async () => {
    const h = planHarness([{ text: "1. do a\n2. do b" }], { mode: "plan", attendance: "client" });
    await h.session.prompt("plan");
    expect(h.plan.pending()).toBeUndefined();
    const plan = h.plan.proposeFromLastReply()!;
    expect(plan.steps.map((s) => s.text)).toEqual(["do a", "do b"]);
    expect(h.plan.pending()?.id).toBe(plan.id);
  });
});
