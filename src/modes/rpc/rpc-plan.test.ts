/**
 * [W5-F] RPC 计划命令（docs/history/wave5-plan.md §6.5）：黄金记录 plan.out.jsonl（声明 plans → plan 模式 →
 * plan_proposed → get_plan → plan_response approve → 执行回合 → get_todos）；未声明能力时按
 * plan.unattended；approve_fresh 新建会话；get_tasks / get_agents 读只读视图（桩）。
 */

import { describe, expect, it } from "vitest";
import { driveRpc, normalizeLine, rpcGolden, type Line } from "../../../test/helpers/rpc-driver.js";
import type { TaskInfo } from "../../tools/types.js";
import { handlers, type RpcContext } from "./commands.js";

const PLAN_REPLY = [
  "<proposed_plan>",
  "# Add greeting",
  "## Steps",
  "- [ ] S1 Read src/hello.ts",
  "- [ ] S2 Add the greeting [depends: S1]",
  "## Verification",
  "- pnpm test",
  "</proposed_plan>",
].join("\n");

const settledCount = (d: { lines: Line[] }) =>
  d.lines.filter((l) => l["type"] === "agent_settled").length;

describe("RPC 计划审批", () => {
  it("黄金记录：plans 能力 → plan_proposed → plan_response approve → 执行 → get_todos", async () => {
    let from = 0;
    const { lines, h } = await driveRpc(
      [
        { text: PLAN_REPLY, usage: { input: 10, output: 5 } },
        { text: "implemented", usage: { input: 20, output: 2 } },
      ],
      async (d) => {
        d.send({ id: "cap", type: "set_client_capabilities", capabilities: ["plans"] });
        await d.waitFor((l) => l["id"] === "cap");
        from = d.lines.length - 1;
        d.send({ id: "mode", type: "set_permission_mode", mode: "plan" });
        d.send({ id: "p", type: "prompt", message: "plan the greeting" });
        const proposed = await d.waitFor((l) => l["type"] === "plan_proposed");
        await d.waitFor(() => settledCount(d) === 1);
        d.send({ id: "get", type: "get_plan" });
        await d.waitFor((l) => l["id"] === "get");
        d.send({
          id: "ok",
          type: "plan_response",
          planId: proposed["planId"],
          decision: "approve",
        });
        await d.waitFor(() => settledCount(d) === 2, "second agent_settled");
        d.send({ id: "todos", type: "get_todos" });
        d.send({ id: "state", type: "get_state" });
        await d.waitFor((l) => l["id"] === "state");
      },
    );
    const byId = (id: string) => lines.find((l) => l["id"] === id) as Line;
    expect(byId("ok")).toMatchObject({ success: true, data: { decision: "approve" } });
    expect(byId("todos")["data"]).toMatchObject({
      items: [
        { id: "S1", status: "in_progress", planStep: "S1" },
        { id: "S2", status: "pending", planStep: "S2" },
      ],
    });
    expect(byId("state")["data"]).toMatchObject({ permissionMode: "default" });
    try {
      rpcGolden(
        "plan.out.jsonl",
        lines
          .slice(from)
          .filter((l) => l["type"] !== "entry_appended" && l["type"] !== "message_update")
          .filter((l) => l["id"] !== "state")
          .map((l) => normalizeLine(l, h.home.root))
          .join("\n") + "\n",
      );
    } finally {
      h.cleanup();
    }
  });

  it("未声明 plans：按 plan.unattended（缺省 stop）——只发 plan_proposed，不执行", async () => {
    const { lines, h } = await driveRpc(
      [{ text: PLAN_REPLY }, { text: "should not run" }],
      async (d) => {
        d.send({ type: "set_permission_mode", mode: "plan" });
        d.send({ type: "prompt", message: "plan" });
        await d.waitFor((l) => l["type"] === "agent_settled");
        await new Promise((r) => setTimeout(r, 20));
        d.send({ id: "s", type: "get_state" });
        await d.waitFor((l) => l["id"] === "s");
      },
    );
    expect(lines.filter((l) => l["type"] === "plan_proposed")).toHaveLength(1);
    expect(lines.filter((l) => l["type"] === "agent_settled")).toHaveLength(1);
    expect((lines.find((l) => l["id"] === "s") as Line)["data"]).toMatchObject({
      permissionMode: "plan",
    });
    h.cleanup();
  });

  it("approve_fresh：新建会话并以计划全文开回合，新会话里有 todo", async () => {
    const { lines, h } = await driveRpc(
      [{ text: PLAN_REPLY }, { text: "fresh run" }],
      async (d) => {
        d.send({ type: "set_client_capabilities", capabilities: ["plans"] });
        d.send({ type: "set_permission_mode", mode: "plan" });
        d.send({ type: "prompt", message: "plan" });
        const proposed = await d.waitFor((l) => l["type"] === "plan_proposed");
        await d.waitFor(() => settledCount(d) === 1);
        d.send({
          id: "fresh",
          type: "plan_response",
          planId: proposed["planId"],
          decision: "approve_fresh",
        });
        await d.waitFor(() => settledCount(d) === 2, "fresh run settled");
        d.send({ id: "todos", type: "get_todos" });
        await d.waitFor((l) => l["id"] === "todos");
      },
    );
    expect(lines.find((l) => l["id"] === "fresh")).toMatchObject({
      success: true,
      data: { decision: "approve_fresh" },
    });
    const starts = lines.filter((l) => l["type"] === "session_start");
    expect(starts.at(-1)).toMatchObject({ reason: "new" });
    const freshUser = lines.find(
      (l) =>
        l["type"] === "message_start" &&
        JSON.stringify(l).includes("Carry out the approved plan below"),
    );
    expect(freshUser).toBeDefined();
    expect((lines.find((l) => l["id"] === "todos") as Line)["data"]).toMatchObject({
      items: [{ id: "S1" }, { id: "S2" }],
    });
    h.cleanup();
  });
});

describe("get_tasks / get_agents（只读视图桩）", () => {
  it("有视图时原样列出，没有时回空表", async () => {
    const task: TaskInfo = {
      taskId: "t1",
      agent: "explore",
      runner: "ama",
      description: "look",
      background: true,
      status: "running",
      startedAt: 1,
    };
    const ctx = {
      tasks: () => ({ list: () => [task], get: () => task }),
      agents: () => [
        { name: "explore", description: "read-only", runner: "ama", source: "builtin" },
      ],
    } as unknown as RpcContext;
    expect(await handlers.get_tasks({}, ctx)).toEqual({ tasks: [task] });
    expect(await handlers.get_agents({}, ctx)).toEqual({
      agents: [{ name: "explore", description: "read-only", runner: "ama", source: "builtin" }],
    });
    const bare = {} as RpcContext;
    expect(await handlers.get_tasks({}, bare)).toEqual({ tasks: [] });
    expect(await handlers.get_agents({}, bare)).toEqual({ agents: [] });
  });
});
