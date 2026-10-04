import { describe, expect, it } from "vitest";
import { TurnCollector } from "./turn.js";
import type { DriverEvent } from "./types.js";

const call = (
  status: "pending" | "in_progress" | "completed" | "failed",
  title = "Write a.txt",
): DriverEvent => ({
  type: "tool_call",
  id: "t1",
  title,
  kind: "edit",
  status,
  locations: ["/w/a.txt"],
});

describe("TurnCollector 的工具进度去重", () => {
  it("审批前后回到已报过的状态（pending → in_progress → pending → in_progress）不重复转发", () => {
    const seen: DriverEvent[] = [];
    const turn = new TurnCollector((e) => seen.push(e));
    for (const status of ["pending", "in_progress", "pending", "in_progress", "completed"] as const)
      turn.push(call(status));
    expect(seen.map((e) => (e.type === "tool_call" ? e.status : e.type))).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
    expect(turn.result("end_turn")).toMatchObject({
      filesTouched: ["/w/a.txt"],
      toolSummary: ["✓ edit Write a.txt"],
    });
  });

  it("同一状态但标题或位置变了照常转发；不同 id 互不影响", () => {
    const seen: DriverEvent[] = [];
    const turn = new TurnCollector((e) => seen.push(e));
    turn.push(call("in_progress"));
    turn.push(call("in_progress"));
    turn.push(call("in_progress", "Write b.txt"));
    turn.push({ ...call("in_progress"), id: "t2" } as DriverEvent);
    expect(seen.map((e) => (e.type === "tool_call" ? `${e.id} ${e.title}` : e.type))).toEqual([
      "t1 Write a.txt",
      "t1 Write b.txt",
      "t2 Write a.txt",
    ]);
  });
});
