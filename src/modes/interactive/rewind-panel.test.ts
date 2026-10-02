/**
 * 回滚面板的按键与回滚文案（RW-C）。
 */

import { describe, expect, it } from "vitest";
import type { CodeRestoreResult, RewindPoint, RewindResult } from "../../checkpoints/types.js";
import { AmaError } from "../../errors.js";
import { plainTheme } from "../../tui.js";
import { RewindPanel, rewindOptions, type RewindChoice } from "./rewind-panel.js";
import {
  badgeText,
  codeResultText,
  gitHintLines,
  rewindErrorText,
  rewindResultLines,
} from "./rewind-text.js";

const POINT: RewindPoint = { entryId: "u2", text: "改一下", timestamp: 0, hasCheckpoint: true };

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

const WITH_CODE: RewindResult = { code: code({ restored: ["a.ts"], insertions: 2, deletions: 1 }) };

function panel(preview: RewindResult | undefined, point = POINT) {
  const chosen: (RewindChoice | undefined)[] = [];
  const p = new RewindPanel(
    { point, now: 0, ...(preview !== undefined ? { preview } : {}) },
    { theme: plainTheme() },
    (choice) => void chosen.push(choice),
  );
  return { p, chosen, keys: (...data: string[]) => data.forEach((d) => p.handleInput(d)) };
}

describe("回滚面板选项", () => {
  it("有代码改动：六项；无改动：两个代码项不出现", () => {
    const labels = (r: RewindResult | undefined) =>
      rewindOptions({ point: POINT, now: 0, ...(r ? { preview: r } : {}) }).map((o) => o.label);
    expect(labels(WITH_CODE)).toEqual([
      "恢复代码和对话",
      "恢复对话",
      "恢复代码",
      "从这里摘要",
      "摘要到这里",
      "取消",
    ]);
    expect(labels({ code: code() })).toEqual(["恢复对话", "从这里摘要", "摘要到这里", "取消"]);
    expect(labels(undefined)).toEqual(["恢复对话", "从这里摘要", "摘要到这里", "取消"]);
  });

  it("数字键直接执行；Enter 执行选中项；取消项返回 undefined", () => {
    let t = panel(WITH_CODE);
    t.keys("3");
    expect(t.chosen).toEqual([{ action: "code" }]);
    t = panel(WITH_CODE);
    t.keys("\x1b[B", "\r");
    expect(t.chosen).toEqual([{ action: "conversation" }]);
    t = panel(WITH_CODE);
    t.keys("6");
    expect(t.chosen).toEqual([undefined]);
  });

  it("摘要项：直接打字成说明，数字也进说明；Esc 先清说明再关闭；数字键不带说明", () => {
    let t = panel(WITH_CODE);
    t.keys("\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B");
    expect(t.p.selectedOption.action).toBe("summarize-up-to");
    t.keys(..."保留 2 处", "\x7f");
    expect(t.p.inputOf("summarize-up-to")).toBe("保留 2 ");
    t.keys("\x1b");
    expect(t.p.inputOf("summarize-up-to")).toBe("");
    expect(t.chosen).toEqual([]);
    t.keys("\x1b");
    expect(t.chosen).toEqual([undefined]);
    t = panel(WITH_CODE);
    t.keys("4");
    expect(t.chosen).toEqual([{ action: "summarize-from" }]);
    t = panel(WITH_CODE);
    t.keys("\x1b[A", "\x1b[A", ..."  只要结论  ", "\r");
    expect(t.chosen).toEqual([{ action: "summarize-up-to", instructions: "只要结论" }]);
  });

  it("非摘要项上打字不生效", () => {
    const t = panel(WITH_CODE);
    t.keys("x", "y");
    expect(t.p.inputOf("both")).toBe("");
    expect(t.chosen).toEqual([]);
  });

  it("冲突：代码类先进第二步；跳过 / 覆盖 / Esc 返回", () => {
    const conflict: RewindResult = { code: code({ restored: ["a.ts"], conflicts: ["b.ts"] }) };
    let t = panel(conflict);
    t.keys("1");
    expect(t.chosen).toEqual([]);
    expect(t.p.render(80).join("\n")).toContain("1 个文件在回合外被改过");
    t.keys("\r");
    expect(t.chosen).toEqual([{ action: "both", onConflict: "skip" }]);
    t = panel(conflict);
    t.keys("3", "2");
    expect(t.chosen).toEqual([{ action: "code", onConflict: "overwrite" }]);
    t = panel(conflict);
    t.keys("1", "\x1b");
    expect(t.p.render(80).join("\n")).toContain("1. 恢复代码和对话");
    t.keys("2");
    expect(t.chosen).toEqual([{ action: "conversation" }]);
  });
});

describe("回滚文案", () => {
  it("统计与结果", () => {
    const c = code({
      restored: ["a", "b"],
      deleted: ["c"],
      conflicts: ["d"],
      skipped: [{ path: "e", reason: "symlink" }],
      insertions: 3,
      deletions: 4,
    });
    expect(badgeText(c)).toBe("3 文件 +3 −4");
    expect(badgeText(c, true)).toBe("3 文件 +3 -4");
    expect(badgeText(code())).toBe("无代码改动");
    expect(badgeText(code({ conflicts: ["x"] }))).toBe("冲突 1 个");
    expect(codeResultText(c)).toBe("已恢复 3 个文件，跳过 2 个（冲突 1、符号链接 1）");
    expect(codeResultText(c, true)).toBe("已恢复 4 个文件，跳过 1 个（符号链接 1）");
    expect(codeResultText(code({ conflicts: ["x"] }))).toBe("没有文件被恢复，跳过 1 个（冲突 1）");
    expect(codeResultText(code())).toBe("代码没有变化");
    const lines = rewindResultLines(
      { code: c, conversation: { leafId: null, draft: { text: "hi" } } },
      { conversation: "对话已回到这条消息之前" },
    );
    expect(lines).toEqual([
      "已恢复 3 个文件，跳过 2 个（冲突 1、符号链接 1）",
      "  d：冲突",
      "  e：符号链接",
      "对话已回到这条消息之前",
    ]);
  });

  it("git 提示：两条命令，只显示", () => {
    expect(gitHintLines({ recordedHead: "a".repeat(40), currentHead: "b".repeat(40) })).toEqual([
      "git HEAD 已变化：aaaaaaa → bbbbbbb（ama 不动 git）",
      "  git log --oneline aaaaaaaaaaaa..HEAD",
      "  git reset --soft aaaaaaaaaaaa",
    ]);
  });

  it("错误码的中文说明", () => {
    expect(rewindErrorText(new AmaError("busy", "cannot rewind while running"))).toContain(
      "先按 Esc 中断",
    );
    expect(rewindErrorText(new AmaError("no_checkpoint", "x"))).toBe(
      "这条消息没有代码检查点，只能恢复对话",
    );
    expect(
      rewindErrorText(
        new AmaError("rewind_failed", "x", {
          detail: code({ failed: [{ path: "a.ts", message: "EACCES" }] }),
        }),
      ),
    ).toBe("没有文件被恢复：a.ts：EACCES");
    expect(rewindErrorText(new Error("other"))).toBe("other");
  });
});
