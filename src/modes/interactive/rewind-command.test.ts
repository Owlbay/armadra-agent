/**
 * `/rewind` 参数解析与执行（RW-C，line 模式与交互模式带参数时共用）。
 */

import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../agent/types.js";
import type { CodeRestoreResult, RewindPoint } from "../../checkpoints/types.js";
import { AmaError } from "../../errors.js";
import { parseRewindArgs, rewindCommand, rewindListText } from "./rewind-command.js";

function code(partial: Partial<CodeRestoreResult> = {}): CodeRestoreResult {
  return {
    restored: [],
    deleted: [],
    conflicts: [],
    skipped: [],
    failed: [],
    insertions: 0,
    deletions: 0,
    ...partial,
  };
}

describe("/rewind 参数（line 模式）", () => {
  it("解析", () => {
    expect(parseRewindArgs("2")).toEqual({ index: 2 });
    expect(parseRewindArgs("2 code overwrite")).toEqual({
      index: 2,
      action: "code",
      overwrite: true,
    });
    expect(parseRewindArgs("1 summarize-from 只留 结论")).toEqual({
      index: 1,
      action: "summarize-from",
      instructions: "只留 结论",
    });
    for (const bad of ["0", "x", "1 nope", "1 conversation overwrite", "1 both extra"]) {
      expect(() => parseRewindArgs(bad)).toThrow(/用法/);
    }
  });

  it("列表与执行（缺省 both，没有检查点时 conversation；错误码换成中文）", async () => {
    const points: RewindPoint[] = [
      { entryId: "u1", text: "第一条", timestamp: 0, hasCheckpoint: false },
      { entryId: "u2", text: "第二条\n两行", timestamp: 0, hasCheckpoint: true },
    ];
    const calls: unknown[] = [];
    const session = {
      rewindPoints: () => points,
      rewind: async (request: { entryId: string; mode: string }) => {
        calls.push(request);
        if (request.mode === "code" && request.entryId === "u1") {
          throw new AmaError("no_checkpoint", "no checkpoint");
        }
        return {
          ...(request.mode !== "code"
            ? { conversation: { leafId: null, draft: { text: "第二条\n两行" } } }
            : {}),
          ...(request.mode !== "conversation" ? { code: code({ restored: ["a.ts"] }) } : {}),
        };
      },
    } as unknown as AgentSession;
    expect(rewindListText(points, 0)).toContain("  1. 刚刚  第一条  [仅对话]");
    expect(rewindListText(points, 0)).toContain("  2. 刚刚  第二条 两行\n".trimEnd());
    const both = await rewindCommand(session, "2", 0);
    expect(calls.at(-1)).toEqual({ entryId: "u2", mode: "both" });
    expect(both).toMatchObject({ reload: true, draft: { text: "第二条\n两行" } });
    expect(both.message).toContain("已恢复 1 个文件");
    await rewindCommand(session, "1", 0);
    expect(calls.at(-1)).toEqual({ entryId: "u1", mode: "conversation" });
    await expect(rewindCommand(session, "1 code", 0)).rejects.toMatchObject({
      code: "no_checkpoint",
      message: "这条消息没有代码检查点，只能恢复对话",
    });
    await expect(rewindCommand(session, "3", 0)).rejects.toThrow(/没有第 3 个回滚点/);
  });
});
