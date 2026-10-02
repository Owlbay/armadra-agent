import { describe, expect, it } from "vitest";
import type { TodoItem } from "../tools/todo.js";
import { applyDoneMarkers, parseDoneMarkers } from "./done-markers.js";

const items: TodoItem[] = [
  { id: "S1", text: "a", status: "in_progress", planStep: "S1" },
  { id: "S2", text: "b", status: "pending", planStep: "S2" },
  { id: "S3", text: "c", status: "pending", planStep: "S3" },
  { id: "x", text: "manual", status: "pending" },
];

describe("[W5-Z] [DONE:n] 文本交接", () => {
  it("只认单独成行的标记，去重保序", () => {
    expect(parseDoneMarkers("did it\n[DONE:S1]\n  [DONE: S2 ]\n[DONE:S1]")).toEqual(["S1", "S2"]);
    expect(parseDoneMarkers("see [DONE:S1] inline")).toEqual([]);
    expect(parseDoneMarkers("```\n[DONE:S3]\n```")).toEqual(["S3"]);
  });

  it("标记的计划步骤转 done，下一个 pending 转 in_progress；非计划条目不动", () => {
    const next = applyDoneMarkers(items, ["s1", "x"]);
    expect(next?.map((i) => i.status)).toEqual(["done", "in_progress", "pending", "pending"]);
    expect(items[0]!.status).toBe("in_progress");
  });

  it("仍有 in_progress 时不另起；没有变化回 undefined", () => {
    const next = applyDoneMarkers(items, ["S3"]);
    expect(next?.map((i) => i.status)).toEqual(["in_progress", "pending", "done", "pending"]);
    expect(applyDoneMarkers(items, ["S9"])).toBeUndefined();
    expect(applyDoneMarkers(items, [])).toBeUndefined();
  });
});
