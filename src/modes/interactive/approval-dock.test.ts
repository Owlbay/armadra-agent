/**
 * 后台任务审批停靠（docs/agents-concurrency-plan.md §2.7，W7-C）：后台任务的请求在不能弹时停靠、条件满足即
 * 弹出；前台任务与主会话的请求直通；停靠期间来了不可停靠的请求立即放出停靠的（审批链串行）；abort 撤掉。
 */

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../agent/types.js";
import type { ApprovalBroker, ApprovalRequest } from "../../permissions/types.js";
import { ApprovalDock } from "./approval-dock.js";

function request(requestId: string, taskId?: string): ApprovalRequest {
  return {
    requestId,
    toolName: "write",
    input: { path: "a.txt" },
    reason: "mode",
    ...(taskId !== undefined ? { context: { depth: 1, taskId } } : {}),
  };
}

function event(type: "permission_request" | "permission_resolved", r: ApprovalRequest) {
  return (
    type === "permission_request"
      ? {
          type,
          requestId: r.requestId,
          toolName: r.toolName,
          input: r.input,
          reason: r.reason,
          timeoutMs: 1000,
          ...(r.context !== undefined ? { context: r.context } : {}),
        }
      : { type, requestId: r.requestId, decision: "allow" }
  ) as SessionEvent;
}

function fixture(background: Set<string>) {
  const asked: string[] = [];
  const inner: ApprovalBroker = {
    ask: async (r) => {
      asked.push(r.requestId);
      return "allow";
    },
  };
  const state = { ready: false, changes: 0 };
  const dock = new ApprovalDock(inner, {
    dockable: (taskId) => background.has(taskId),
    ready: () => state.ready,
    changed: () => void state.changes++,
    pollMs: 1e9,
  });
  return { dock, asked, state };
}

describe("ApprovalDock", () => {
  it("主会话与前台任务的请求直通", async () => {
    const f = fixture(new Set(["t2"]));
    expect(await f.dock.ask(request("r1"), new AbortController().signal)).toBe("allow");
    expect(await f.dock.ask(request("r2", "t1"), new AbortController().signal)).toBe("allow");
    expect(f.asked).toEqual(["r1", "r2"]);
    expect(f.dock.size).toBe(0);
  });

  it("后台任务：忙时停靠，就绪后 poke 弹出", async () => {
    const f = fixture(new Set(["t2"]));
    const answer = f.dock.ask(request("r1", "t2"), new AbortController().signal);
    await Promise.resolve();
    expect(f.asked).toEqual([]);
    expect([...f.dock.tasks()]).toEqual(["t2"]);
    expect(f.state.changes).toBe(1);
    f.dock.poke();
    expect(f.asked).toEqual([]);
    f.state.ready = true;
    f.dock.poke();
    expect(await answer).toBe("allow");
    expect(f.asked).toEqual(["r1"]);
    expect(f.dock.size).toBe(0);
  });

  it("就绪时直接弹出，不停靠", async () => {
    const f = fixture(new Set(["t2"]));
    f.state.ready = true;
    expect(await f.dock.ask(request("r1", "t2"), new AbortController().signal)).toBe("allow");
    expect(f.state.changes).toBe(0);
  });

  it("停靠期间来了主会话的请求：立即放出停靠的（链串行，否则主会话一直等）", async () => {
    const f = fixture(new Set(["t2"]));
    const docked = request("r1", "t2");
    f.dock.observe(event("permission_request", docked));
    const answer = f.dock.ask(docked, new AbortController().signal);
    expect(f.dock.size).toBe(1);
    f.dock.observe(event("permission_request", request("r2")));
    expect(await answer).toBe("allow");
    expect(f.asked).toEqual(["r1"]);
    // 主会话的请求还没答复：新来的后台请求也不停靠
    expect(await f.dock.ask(request("r3", "t2"), new AbortController().signal)).toBe("allow");
    f.dock.observe(event("permission_resolved", request("r2")));
    void f.dock.ask(request("r4", "t2"), new AbortController().signal);
    expect(f.dock.size).toBe(1);
  });

  it("abort（超时 / 中止）：撤掉停靠项，按 undefined 交回链", async () => {
    const f = fixture(new Set(["t2"]));
    const controller = new AbortController();
    const answer = f.dock.ask(request("r1", "t2"), controller.signal);
    controller.abort();
    expect(await answer).toBeUndefined();
    expect(f.dock.size).toBe(0);
    expect(f.asked).toEqual([]);
  });

  it("dispose：停靠的请求交回 undefined", async () => {
    const f = fixture(new Set(["t2"]));
    const answer = f.dock.ask(request("r1", "t2"), new AbortController().signal);
    f.dock.dispose();
    expect(await answer).toBeUndefined();
  });

  it("定时器：就绪后自动弹出", async () => {
    const asked: string[] = [];
    let ready = false;
    const dock = new ApprovalDock(
      { ask: async (r) => (asked.push(r.requestId), "deny") },
      { dockable: () => true, ready: () => ready, changed: () => undefined, pollMs: 5 },
    );
    const answer = dock.ask(request("r1", "t2"), new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toEqual([]);
    ready = true;
    expect(await answer).toBe("deny");
  });
});
