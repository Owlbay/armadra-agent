/**
 * [W6-T2] SDK `session.trace()`（docs/wave6-plan.md §2.6、D29）：缺省全部回合、`turnLimit` 尾部、`taskId` 不存在
 * 抛 task_not_found；与 RPC 同一查询（`sessionTrace`）。
 */

import { describe, expect, it } from "vitest";
import { createDefaultApiRegistry } from "../ai/apis/api.js";
import { FakeProvider } from "../ai/fake/fake-provider.js";
import { createAgentSession } from "../sdk.js";
import { sessionTrace } from "./query-session.js";

async function idle(session: { waitForIdle(): Promise<void> }): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1));
    await session.waitForIdle();
  }
}

describe("SDK session.trace()", () => {
  it("全部回合 / turnLimit / taskId", async () => {
    const fake = new FakeProvider([{ text: "one" }, { text: "two" }, { text: "three" }]);
    const apis = createDefaultApiRegistry();
    apis.register(fake.api);
    const session = await createAgentSession({ model: "fake/echo", apis, tools: "none" });
    for (const p of ["a", "b", "c"]) {
      await session.prompt(p);
      await idle(session);
    }
    const trace = session.trace?.();
    expect(trace?.turns).toHaveLength(3);
    expect(trace?.totals.requests).toBe(3);
    expect(session.trace?.({ turnLimit: 1 }).turns).toHaveLength(1);
    expect(() => session.trace?.({ taskId: "t9" })).toThrow(/t9/);
    const rpc = sessionTrace(session, { turnLimit: 2 });
    expect(rpc.hasMoreBefore).toBe(true);
    expect(rpc.trace.turns.map((t) => t.id)).toEqual(trace?.turns.slice(1).map((t) => t.id));
    await session.dispose();
  });
});
