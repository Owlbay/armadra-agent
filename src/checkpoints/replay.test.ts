import { describe, expect, it } from "vitest";
import { isRewindable, latestCheckpoint, loadCheckpoints, rewindableIds } from "./replay.js";
import { CHECKPOINT_CUSTOM_TYPE, CHECKPOINT_TRACK_CUSTOM_TYPE } from "./types.js";

const H = (c: string): string => c.repeat(64);
const cp = (userEntryId: string, files: Record<string, unknown>) => ({
  type: "custom",
  customType: CHECKPOINT_CUSTOM_TYPE,
  data: { v: 1, userEntryId, files },
  timestamp: "2026-10-02T00:00:00.000Z",
});
const track = (userEntryId: string, path: string, blob: string | null) => ({
  type: "custom",
  customType: CHECKPOINT_TRACK_CUSTOM_TYPE,
  data: { v: 1, userEntryId, path, record: { blob } },
});

describe("loadCheckpoints", () => {
  it("合并 track、记最早记录、跳过坏条目与其它条目", () => {
    const state = loadCheckpoints([
      { type: "message" },
      cp("u1", {}),
      track("u1", "a.txt", H("a")),
      cp("u2", { "a.txt": { blob: H("b") } }),
      track("u2", "b.txt", null),
      track("u2", "a.txt", H("c")), // 已有 a.txt：不覆盖
      { type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: { v: 2 } },
      cp("u3", { "x.txt": { blob: "not-a-hash" } }),
      track("u9", "c.txt", H("d")), // 检查点缺失：补一个空壳
    ]);
    expect(state.order).toEqual(["u1", "u2", "u3", "u9"]);
    expect(state.byUserEntry.get("u1")?.files).toEqual({ "a.txt": { blob: H("a") } });
    expect(state.byUserEntry.get("u2")?.files).toEqual({
      "a.txt": { blob: H("b") },
      "b.txt": { blob: null },
    });
    expect(state.byUserEntry.get("u3")?.files).toEqual({});
    expect(state.earliest.get("a.txt")).toEqual({ blob: H("a") });
    expect(state.earliest.get("b.txt")).toEqual({ blob: null });
    expect(state.byUserEntry.get("u9")?.files["c.txt"]?.blob).toBe(H("d"));
    expect(latestCheckpoint(state)?.userEntryId).toBe("u9");
  });

  it("keep：只有最近 N 个检查点可回滚", () => {
    const state = loadCheckpoints([cp("u1", {}), cp("u2", {}), cp("u3", {})]);
    expect([...rewindableIds(state, 2)]).toEqual(["u2", "u3"]);
    expect(isRewindable(state, "u1", 2)).toBe(false);
    expect(isRewindable(state, "u3", 2)).toBe(true);
    expect(isRewindable(state, "u1")).toBe(true);
    expect(isRewindable(state, "nope")).toBe(false);
  });
});
