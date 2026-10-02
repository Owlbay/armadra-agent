/**
 * 回滚列表与确认面板的帧黄金（RW-C）：真实组件 + MemoryTerminal，数据为构造的回滚点与 dry-run 结果。
 * 更新：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive/rewind-frames.test.ts`，逐个审阅 diff。
 */

import { describe, expect, it } from "vitest";
import type { RewindPoint, RewindResult } from "../../checkpoints/types.js";
import { MemoryTerminal, TUI, Text, plainTheme, type Theme } from "../../tui.js";
import { openRewindPanel, type RewindFlowHost } from "./rewind-flow.js";
import { PreviewCache, openRewindList } from "./rewind-list.js";
import type { RewindChoice, RewindPanelModel } from "./rewind-panel.js";
import { golden } from "./test-support.js";

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const MIN = 60_000;

const POINTS: RewindPoint[] = [
  {
    entryId: "u1",
    text: "读一下 README，说说是什么",
    timestamp: NOW - 42 * MIN,
    hasCheckpoint: false,
  },
  { entryId: "u2", text: "给 parser 加上错误恢复", timestamp: NOW - 20 * MIN, hasCheckpoint: true },
  {
    entryId: "u3",
    text: "把 src/tui/tui.ts 的差分渲染改成按行比较，\n顺便补上测试\n再更新文档\n最后跑一遍 CI",
    timestamp: NOW - 3 * MIN,
    hasCheckpoint: true,
  },
];

const CODE: RewindResult = {
  code: {
    restored: ["src/tui/tui.ts", "src/tui/tui.test.ts"],
    deleted: ["src/tui/diff.ts"],
    conflicts: [],
    skipped: [],
    failed: [],
    insertions: 12,
    deletions: 48,
  },
};

const NO_CODE: RewindResult = {
  code: {
    restored: [],
    deleted: [],
    conflicts: [],
    skipped: [],
    failed: [],
    insertions: 0,
    deletions: 0,
  },
};

const CONFLICT: RewindResult = {
  code: {
    ...CODE.code!,
    conflicts: ["README.md"],
    skipped: [{ path: "assets/big.bin", reason: "too_large" }],
  },
};

const GIT: RewindResult = {
  ...CODE,
  gitHint: {
    recordedHead: "3f2a9c1e0b7d4c55aa01b2c3d4e5f60718293a4b",
    currentHead: "9e8d7c6b5a49382716051f2e3d4c5b6a79881726",
  },
};

interface Screen {
  terminal: MemoryTerminal;
  tui: TUI;
  host: RewindFlowHost;
  shot(label: string): string;
}

function screen(columns: number, rows: number, theme: Theme = plainTheme()): Screen {
  const terminal = new MemoryTerminal({ columns, rows });
  const tui = new TUI(terminal);
  tui.addChild(new Text("先前的对话"));
  tui.start();
  const host: RewindFlowHost = {
    theme,
    showOverlay: (c, o) => tui.showOverlay(c, o),
    columns: () => columns,
    rows: () => rows,
    render: () => undefined,
    now: () => NOW,
    session: () => {
      throw new Error("not used");
    },
    notice: () => undefined,
    hint: () => undefined,
    reload: () => undefined,
    setDraft: () => undefined,
    editorEmpty: () => true,
  };
  return {
    terminal,
    tui,
    host,
    shot(label) {
      tui.renderNow();
      const out = [`# ${label} · viewport ${columns}x${rows}`];
      out.push(...terminal.viewport().map((l) => `|${l.replace(/\s+$/, "")}`));
      return out.join("\n") + "\n";
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function listFrames(
  s: Screen,
  results: Record<string, RewindResult | Error>,
  moves: string[] = [],
): Promise<string[]> {
  const cache = new PreviewCache(async (id) => {
    const r = results[id];
    if (r instanceof Error) throw r;
    return r ?? NO_CODE;
  });
  const frames: string[] = [];
  const picked = openRewindList(s.host, POINTS, cache);
  frames.push(s.shot("list · computing"));
  await tick();
  frames.push(s.shot("list · last highlighted"));
  for (const key of moves) {
    s.terminal.sendInput(key);
    await tick();
    frames.push(s.shot(`list · after ${JSON.stringify(key)}`));
  }
  s.terminal.sendInput("\x1b");
  s.terminal.flushInput();
  expect(await picked).toBeUndefined();
  return frames;
}

async function panelFrames(
  s: Screen,
  model: RewindPanelModel,
  keys: string[] = [],
): Promise<{ frames: string[]; choice: RewindChoice | undefined }> {
  const frames: string[] = [];
  const chosen = openRewindPanel(s.host, model);
  frames.push(s.shot("panel"));
  for (const key of keys) {
    s.terminal.sendInput(key);
    s.terminal.flushInput();
    frames.push(s.shot(`panel · after ${JSON.stringify(key)}`));
  }
  let settled = false;
  void chosen.then(() => (settled = true));
  await tick();
  if (!settled) {
    s.terminal.sendInput("\x1b");
    s.terminal.flushInput();
  }
  return { frames, choice: await chosen };
}

describe("回滚列表", () => {
  for (const [columns, rows] of [
    [80, 24],
    [40, 16],
  ] as const) {
    it(`${columns}x${rows}：有代码改动、无代码改动（↑）、仅对话（↑↑）`, async () => {
      const s = screen(columns, rows);
      const frames = await listFrames(s, { u3: CODE, u2: NO_CODE }, ["\x1b[A", "\x1b[A"]);
      golden(`rewind-list-${columns}x${rows}`, frames.join("\n"));
    });
  }

  it("预览失败显示 —", async () => {
    const s = screen(80, 24);
    const frames = await listFrames(s, { u3: new Error("boom") });
    expect(frames[1]).toMatch(/差分渲染.*—/);
  });
});

describe("回滚确认面板", () => {
  const point = POINTS[2]!;
  for (const [columns, rows] of [
    [80, 24],
    [40, 16],
  ] as const) {
    it(`${columns}x${rows}：有代码改动`, async () => {
      const s = screen(columns, rows);
      const { frames } = await panelFrames(s, { point, preview: CODE, now: NOW }, ["\x1b[B"]);
      golden(`rewind-panel-code-${columns}x${rows}`, frames.join("\n"));
    });
  }

  it("80x24：无代码改动只有对话与摘要项", async () => {
    const s = screen(80, 24);
    const { frames, choice } = await panelFrames(s, { point, preview: NO_CODE, now: NOW }, ["1"]);
    expect(choice).toEqual({ action: "conversation" });
    golden("rewind-panel-nocode-80x24", frames.join("\n"));
  });

  it("80x24：仅对话（没有检查点）", async () => {
    const s = screen(80, 24);
    const { frames } = await panelFrames(s, { point: POINTS[0]!, now: NOW });
    golden("rewind-panel-conversation-only-80x24", frames.join("\n"));
  });

  it("80x24：冲突与跳过清单 → 选恢复代码和对话 → 覆盖冲突文件", async () => {
    const s = screen(80, 24);
    const { frames, choice } = await panelFrames(s, { point, preview: CONFLICT, now: NOW }, [
      "\r",
      "2",
    ]);
    expect(choice).toEqual({ action: "both", onConflict: "overwrite" });
    golden("rewind-panel-conflict-80x24", frames.join("\n"));
  });

  it("80x24：git HEAD 变化提示与两条命令", async () => {
    const s = screen(80, 24);
    const { frames } = await panelFrames(s, { point, preview: GIT, now: NOW });
    golden("rewind-panel-git-80x24", frames.join("\n"));
  });

  it("40x16：冲突 + 跳过 + git 放不下时紧凑排版（原文 1 行、清单并行）", async () => {
    const s = screen(40, 16);
    const preview: RewindResult = { ...CONFLICT, gitHint: GIT.gitHint! };
    const { frames, choice } = await panelFrames(s, { point, preview, now: NOW }, ["\r", "3", "6"]);
    expect(choice).toBeUndefined();
    for (const frame of frames.slice(0, 2)) expect(frame).toContain("回滚到这条消息之前");
    golden("rewind-panel-tight-40x16", frames.slice(0, 2).join("\n"));
  });

  it("80x24：摘要行内输入说明，Enter 提交", async () => {
    const s = screen(80, 24);
    const keys = ["\x1b[B", "\x1b[B", "\x1b[B", ..."只保留结论 1", "\r"];
    const { frames, choice } = await panelFrames(s, { point, preview: CODE, now: NOW }, keys);
    expect(choice).toEqual({ action: "summarize-from", instructions: "只保留结论 1" });
    golden("rewind-panel-summarize-80x24", [frames[0]!, frames[3]!, frames.at(-2)!].join("\n"));
  });

  it("ASCII 80x24：列表与面板", async () => {
    const theme = plainTheme({ ascii: true });
    const list = await listFrames(screen(80, 24, theme), { u3: CODE });
    const { frames } = await panelFrames(screen(80, 24, theme), {
      point,
      preview: GIT,
      now: NOW,
    });
    for (const frame of [...list, ...frames]) {
      // 标签超宽时 SelectList 的截断号仍是 `…`（组件库行为）
      expect(frame.replace(/^#.*$/gm, "")).toMatch(/^[\x20-\x7e\n一-鿿（）：，、·—…]*$/u);
    }
    golden("rewind-ascii-80x24", [list[1]!, frames[0]!].join("\n"));
  });
});
