/**
 * [W5-F] SDK 计划：`plan.onProposed` 审批回调与 `session.plan`（docs/wave5-plan.md §6.5）。
 */

import { describe, expect, it } from "vitest";
import { createDefaultApiRegistry } from "./ai/apis/api.js";
import { FakeProvider } from "./ai/fake/fake-provider.js";
import type { FakeResponse } from "./ai/fake/fake-script.js";
import { createAgentSession, type PlanData } from "./sdk.js";

const PLAN_REPLY = "<proposed_plan>\n# T\n## Steps\n- [ ] S1 one\n- [ ] S2 two\n</proposed_plan>";

function fakeApis(script: FakeResponse[]) {
  const fake = new FakeProvider(script);
  const apis = createDefaultApiRegistry();
  apis.register(fake.api);
  return { fake, apis };
}

async function idle(session: { waitForIdle(): Promise<void> }): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1));
    await session.waitForIdle();
  }
}

describe("SDK plan", () => {
  it("onProposed 批准：切到指定模式、生成 todo 并执行", async () => {
    const { fake, apis } = fakeApis([{ text: PLAN_REPLY }, { text: "done" }]);
    const seen: PlanData[] = [];
    const session = await createAgentSession({
      model: "fake/echo",
      apis,
      tools: "none",
      permission: { mode: "plan" },
      plan: {
        onProposed: async (plan) => {
          seen.push(plan);
          return { decision: "approve", mode: "auto-edit" };
        },
      },
    });
    await session.prompt("plan it");
    await idle(session);
    expect(seen.map((p) => p.steps.length)).toEqual([2]);
    expect(fake.calls).toHaveLength(2);
    expect(session.state.permissionMode).toBe("auto-edit");
    expect(session.plan.current()?.status).toBe("approved");
    expect(session.plan.todos().map((t) => t.id)).toEqual(["S1", "S2"]);
    await session.dispose();
  });

  it("没有 onProposed：缺省 stop，计划留待 session.plan.respond()", async () => {
    const { fake, apis } = fakeApis([{ text: PLAN_REPLY }, { text: "done" }]);
    const session = await createAgentSession({
      model: "fake/echo",
      apis,
      tools: "none",
      permission: { mode: "plan" },
    });
    await session.prompt("plan it");
    await idle(session);
    expect(fake.calls).toHaveLength(1);
    const plan = session.plan.current()!;
    expect(plan.status).toBe("proposed");
    await session.plan.respond({ planId: plan.id, decision: "reject" });
    expect(session.plan.current()?.status).toBe("rejected");
    await session.dispose();
  });

  it("plan.unattended: approve 来自 SDK 选项", async () => {
    const { fake, apis } = fakeApis([{ text: PLAN_REPLY }, { text: "done" }]);
    const session = await createAgentSession({
      model: "fake/echo",
      apis,
      tools: "none",
      permission: { mode: "plan" },
      plan: { unattended: "approve" },
    });
    await session.prompt("plan it");
    await idle(session);
    expect(fake.calls).toHaveLength(2);
    expect(session.state.permissionMode).toBe("default");
    await session.dispose();
  });
});
