import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import type { Message } from "../ai/types.js";
import { createCheckpointBackendFactory } from "../checkpoints/index.js";
import { REWIND_NOTE_CUSTOM_TYPE } from "../checkpoints/types.js";
import { sessionDirForCwd } from "../session/store.js";
import { createEditTool } from "../tools/edit.js";
import { createReadTool } from "../tools/read.js";
import { createTaskTool } from "../tools/task.js";
import type { ToolDefinition } from "../tools/types.js";
import { createWriteTool } from "../tools/write.js";
import { stubCheckpoints } from "./testing/checkpoint-stub.js";
import { createHarness, type Harness, type HarnessOptions } from "./testing/harness.js";
import type { ScriptStep, ScriptToolCall } from "./testing/scripted-api.js";
import { stubHooks, stubTool } from "./testing/stubs.js";
import { codeNote, conversationNote, listFiles } from "./session-rewind.js";
import type { SessionEvent } from "./types.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const TOOLS = [
  createReadTool(),
  createEditTool(),
  createWriteTool(),
  createTaskTool(),
] as ToolDefinition[];

function calls(...list: ScriptToolCall[]): ScriptStep {
  return { toolCalls: list };
}
const read = (path: string): ScriptToolCall => ({ name: "read", args: { path } });
const edit = (path: string, oldText: string, newText: string): ScriptToolCall => ({
  name: "edit",
  args: { path, edits: [{ oldText, newText }] },
});
const write = (path: string, content: string): ScriptToolCall => ({
  name: "write",
  args: { path, content },
});

interface Fixture {
  h: Harness;
  cwd: string;
  file(name: string): string;
  backend(): ReturnType<typeof stubCheckpoints>["backends"][number];
}

function fixture(script: ScriptStep[], options: Partial<HarnessOptions> = {}): Fixture {
  home = createTmpHome("ama-rw-b-");
  const cwd = home.cwd;
  writeFileSync(join(cwd, "a.txt"), "alpha\n");
  writeFileSync(join(cwd, "b.txt"), "beta\n");
  const stub = stubCheckpoints();
  const h = createHarness({
    script,
    cwd,
    dir: sessionDirForCwd(home.dataDir, cwd),
    tools: TOOLS,
    checkpoints: stub.factory,
    cache: { warming: "off" },
    ...options,
  });
  return {
    h,
    cwd,
    file: (name) => readFileSync(join(cwd, name), "utf8"),
    backend: () => {
      const backend = stub.backends[0];
      if (backend === undefined) throw new Error("no backend");
      return backend;
    },
  };
}

/** 第 1 回合读 a、b；第 2 回合改 a、b。 */
const READ_THEN_EDIT: ScriptStep[] = [
  calls(read("a.txt"), read("b.txt")),
  { text: "read both" },
  calls(edit("a.txt", "alpha", "ALPHA"), edit("b.txt", "beta", "BETA")),
  { text: "edited both" },
];

function of<T extends SessionEvent["type"]>(h: Harness, type: T) {
  return h.events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
}

function lastUserIndex(messages: readonly Message[]): number {
  return messages.findLastIndex((message) => message.role === "user");
}

describe("回滚点与检查点接线", () => {
  it("新回合用户消息落盘后建检查点；steer 并入当前回合不建；hasCheckpoint 来自后端", async () => {
    let steered = false;
    const f = fixture([calls({ name: "nudge", args: {} }), { text: "ok" }, { text: "two" }], {
      tools: [
        ...TOOLS,
        stubTool({
          name: "nudge",
          run: () => {
            steered = true;
            void f.h.session.steer("also this");
            return { content: "nudged" };
          },
        }),
      ],
    });
    await f.h.session.prompt("first");
    expect(steered).toBe(true);
    await f.h.session.prompt("second");
    const points = f.h.session.rewindPoints();
    expect(points.map((p) => p.text)).toEqual(["first", "second"]);
    expect(points.every((p) => p.hasCheckpoint)).toBe(true);
    expect(f.backend().snapshots).toEqual(points.map((p) => p.entryId));
    // 检查点条目紧跟在用户消息之后
    const entries = f.h.manager.entries();
    const at = entries.findIndex((e) => e.id === points[0]!.entryId);
    expect(entries[at + 1]).toMatchObject({ type: "custom", customType: "ama.checkpoint" });
  });

  it("内存会话不建检查点：只能仅对话；代码回滚报 no_checkpoint", async () => {
    const stub = stubCheckpoints();
    const h = createHarness({ script: [{ text: "a" }], checkpoints: stub.factory });
    await h.session.prompt("hi");
    expect(stub.backends).toHaveLength(0);
    const [point] = h.session.rewindPoints();
    expect(point).toMatchObject({ text: "hi", hasCheckpoint: false });
    await expect(h.session.rewind({ entryId: point!.entryId, mode: "code" })).rejects.toMatchObject(
      { code: "no_checkpoint" },
    );
    const result = await h.session.rewind({ entryId: point!.entryId, mode: "conversation" });
    expect(result.conversation?.draft).toEqual({ text: "hi" });
    expect(h.session.messages.some((m) => m.role === "user")).toBe(false);
  });

  it("task 子会话的编辑记到父会话当前回合，可随父会话回滚", async () => {
    const f = fixture([
      calls({ name: "task", args: { prompt: "make c" } }),
      calls(write("c.txt", "gamma\n")),
      { text: "child done" },
      { text: "parent done" },
    ]);
    await f.h.session.prompt("delegate");
    expect(f.file("c.txt")).toBe("gamma\n");
    const [point] = f.h.session.rewindPoints();
    expect(f.backend().beforeWrites).toEqual([
      { path: join(f.cwd, "c.txt"), turn: point!.entryId },
    ]);
    const result = await f.h.session.rewind({ entryId: point!.entryId, mode: "both" });
    expect(result.code?.deleted).toEqual(["c.txt"]);
    expect(existsSync(join(f.cwd, "c.txt"))).toBe(false);
  });

  it("运行中 rewind → busy", async () => {
    const f = fixture([{ kind: "hang" }]);
    const running = f.h.session.prompt("wait");
    await new Promise((r) => setTimeout(r, 20));
    const [point] = f.h.session.rewindPoints();
    await expect(
      f.h.session.rewind({ entryId: point!.entryId, mode: "conversation" }),
    ).rejects.toMatchObject({ code: "busy" });
    await f.h.session.abort();
    await running;
  });
});

describe("rewind：对话 + 代码", () => {
  it("改两个文件后回滚：文件与对话回到之前、readFiles 去掉被恢复文件、下一请求前缀逐字节不变", async () => {
    const f = fixture([...READ_THEN_EDIT, { text: "again" }]);
    await f.h.session.prompt("read a and b");
    await f.h.session.prompt("edit a and b");
    expect(f.file("a.txt")).toBe("ALPHA\n");
    const before = f.h.scripted.calls[2]!.context.messages;
    const cut = lastUserIndex(before);
    const points = f.h.session.rewindPoints();
    const target = points[1]!;

    const preview = await f.h.session.rewind({
      entryId: target.entryId,
      mode: "both",
      dryRun: true,
    });
    expect(preview.code?.restored).toEqual(["a.txt", "b.txt"]);
    expect(f.file("a.txt")).toBe("ALPHA\n");
    expect(of(f.h, "session_rewound")).toHaveLength(0);

    const result = await f.h.session.rewind({ entryId: target.entryId, mode: "both" });
    expect(result.code).toMatchObject({ restored: ["a.txt", "b.txt"], deleted: [], failed: [] });
    expect(result.conversation).toEqual({
      leafId: f.h.manager.getEntry(target.entryId)!.parentId,
      draft: { text: "edit a and b" },
    });
    expect(f.backend().restores.at(-1)).toEqual({
      userEntryId: target.entryId,
      dryRun: false,
      onConflict: "skip",
    });
    expect([f.file("a.txt"), f.file("b.txt")]).toEqual(["alpha\n", "beta\n"]);
    expect(f.h.manager.leafId()).toBe(result.conversation!.leafId);
    expect(f.h.session.readFiles.has(join(f.cwd, "a.txt"))).toBe(false);
    expect(f.h.session.readFiles.has(join(f.cwd, "b.txt"))).toBe(false);
    expect(of(f.h, "session_rewound")).toEqual([
      {
        type: "session_rewound",
        entryId: target.entryId,
        mode: "both",
        restored: ["a.txt", "b.txt"],
        deleted: [],
        conflicts: [],
        skipped: [],
      },
    ]);

    await f.h.session.prompt("edit a and b");
    const after = f.h.scripted.calls.at(-1)!.context.messages;
    expect(lastUserIndex(after)).toBe(cut);
    expect(JSON.stringify(after.slice(0, cut))).toBe(JSON.stringify(before.slice(0, cut)));
    // 对话 + 代码：两边一致，不追加提示
    expect(JSON.stringify(after)).not.toContain("rewound");
  });

  it("PostRewind Hook 收到 { entryId, mode, files }", async () => {
    const hooks = stubHooks({ PostRewind: () => undefined });
    const f = fixture(READ_THEN_EDIT, { hooks });
    await f.h.session.prompt("read");
    await f.h.session.prompt("edit");
    const target = f.h.session.rewindPoints()[1]!;
    await f.h.session.rewind({ entryId: target.entryId, mode: "code" });
    await new Promise((r) => setTimeout(r, 0));
    expect(hooks.calls.filter((c) => c.event === "PostRewind")).toEqual([
      {
        event: "PostRewind",
        payload: { entryId: target.entryId, mode: "code", files: ["a.txt", "b.txt"] },
      },
    ]);
  });

  it("全部失败且无一恢复 → rewind_failed，对话不动；gitHint 原样带回", async () => {
    const f = fixture(READ_THEN_EDIT);
    await f.h.session.prompt("read");
    await f.h.session.prompt("edit");
    const target = f.h.session.rewindPoints()[1]!;
    const leaf = f.h.manager.leafId();
    f.backend().gitHintValue = { recordedHead: "abc", currentHead: "def" };
    const preview = await f.h.session.rewind({
      entryId: target.entryId,
      mode: "both",
      dryRun: true,
    });
    expect(preview.gitHint).toEqual({ recordedHead: "abc", currentHead: "def" });
    f.backend().failRestore = true;
    await expect(
      f.h.session.rewind({ entryId: target.entryId, mode: "both" }),
    ).rejects.toMatchObject({ code: "rewind_failed" });
    expect(f.h.manager.leafId()).toBe(leaf);
  });
});

describe("rewind：真实检查点后端（RW-A）", () => {
  it("edit 两个文件 → rewind both → 磁盘内容回到之前，备份在临时数据目录", async () => {
    home = createTmpHome("ama-rw-b-real-");
    const cwd = home.cwd;
    writeFileSync(join(cwd, "a.txt"), "alpha\n");
    writeFileSync(join(cwd, "b.txt"), "beta\n");
    const h = createHarness({
      script: [...READ_THEN_EDIT, { text: "again" }],
      cwd,
      dir: sessionDirForCwd(home.dataDir, cwd),
      tools: TOOLS,
      checkpoints: createCheckpointBackendFactory({ mode: "tools", dataDir: home.dataDir }),
      cache: { warming: "off" },
    });
    await h.session.prompt("read a and b");
    await h.session.prompt("edit a and b");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("ALPHA\n");
    const points = h.session.rewindPoints();
    expect(points.map((p) => p.hasCheckpoint)).toEqual([true, true]);

    const preview = await h.session.rewind({
      entryId: points[1]!.entryId,
      mode: "both",
      dryRun: true,
    });
    expect(preview.code).toMatchObject({
      restored: ["a.txt", "b.txt"],
      insertions: 2,
      deletions: 2,
    });

    const result = await h.session.rewind({ entryId: points[1]!.entryId, mode: "both" });
    expect(result.code).toMatchObject({ restored: ["a.txt", "b.txt"], conflicts: [], failed: [] });
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("beta\n");
    expect(h.session.readFiles.has(join(cwd, "a.txt"))).toBe(false);
    expect(readdirSync(join(home.dataDir, "file-history", "blobs")).length).toBeGreaterThan(0);
    await h.session.prompt("edit a and b");
    expect(h.session.rewindPoints().map((p) => p.text)).toEqual(["read a and b", "edit a and b"]);
  });

  it("checkpoints.mode off → 无后端，只能仅对话", async () => {
    home = createTmpHome("ama-rw-b-off-");
    const h = createHarness({
      script: [{ text: "a" }],
      cwd: home.cwd,
      dir: sessionDirForCwd(home.dataDir, home.cwd),
      checkpoints: createCheckpointBackendFactory({ mode: "off", dataDir: home.dataDir }),
    });
    await h.session.prompt("hi");
    expect(h.session.rewindPoints()[0]?.hasCheckpoint).toBe(false);
    expect(h.session.checkpointHooks()).toBeUndefined();
  });
});

describe("rewind：一致性提示（§3.4）", () => {
  const noteEntries = (h: Harness) =>
    h.manager
      .branch()
      .filter((e) => e.type === "custom_message" && e.customType === REWIND_NOTE_CUSTOM_TYPE);

  it("仅对话：文件保留之后的修改 → 下一次提示前在末尾追加 note，列出文件", async () => {
    const f = fixture([...READ_THEN_EDIT, { text: "next" }]);
    await f.h.session.prompt("read");
    await f.h.session.prompt("edit");
    const target = f.h.session.rewindPoints()[1]!;
    const result = await f.h.session.rewind({ entryId: target.entryId, mode: "conversation" });
    expect(result.code).toBeUndefined();
    expect(f.file("a.txt")).toBe("ALPHA\n");
    // 与目标检查点不一致的文件不能当作「已读」
    expect(f.h.session.readFiles.has(join(f.cwd, "a.txt"))).toBe(false);
    expect(noteEntries(f.h)).toHaveLength(0); // 留到下一次提示前
    await f.h.session.prompt("go on");
    const notes = noteEntries(f.h);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ content: conversationNote(["a.txt", "b.txt"]) });
    const messages = f.h.scripted.calls.at(-1)!.context.messages;
    const last = messages.at(-1)!;
    expect(last).toMatchObject({ role: "user", content: "go on" });
    expect(JSON.stringify(messages.at(-2))).toContain("keep the changes");
  });

  it("仅代码：文件恢复、对话不动 → note 写明第 N 条消息", async () => {
    const f = fixture([...READ_THEN_EDIT, { text: "next" }]);
    await f.h.session.prompt("read");
    await f.h.session.prompt("edit");
    const leaf = f.h.manager.leafId();
    const target = f.h.session.rewindPoints()[1]!;
    const result = await f.h.session.rewind({ entryId: target.entryId, mode: "code" });
    expect(result.conversation).toBeUndefined();
    expect(f.h.manager.leafId()).toBe(leaf);
    expect(f.file("b.txt")).toBe("beta\n");
    expect(f.h.session.readFiles.has(join(f.cwd, "b.txt"))).toBe(false);
    await f.h.session.prompt("go on");
    expect(noteEntries(f.h)[0]).toMatchObject({ content: codeNote(["a.txt", "b.txt"], 2) });
  });

  it("文件清单最多 20 个，其余计数", () => {
    const files = Array.from({ length: 23 }, (_, i) => `f${i}.ts`);
    const text = listFiles(files);
    expect(text.split("\n")).toHaveLength(21);
    expect(text).toContain("and 3 more");
  });
});

describe("摘要两项（§3.5）", () => {
  const summary = { text: "## Goal\n- summary" };

  it("从这里摘要：回到该消息之前、写 branch_summary、回填原消息", async () => {
    const f = fixture([{ text: "one" }, { text: "two" }, summary]);
    await f.h.session.prompt("first");
    await f.h.session.prompt("second");
    const target = f.h.session.rewindPoints()[1]!;
    const result = await f.h.session.summarizeFrom(target.entryId, "focus on X");
    expect(result.draft).toEqual({ text: "second" });
    expect(result.summary).toMatchObject({ type: "branch_summary", summary: "## Goal\n- summary" });
    expect(f.h.manager.leafId()).toBe(result.summary!.id);
    expect(JSON.stringify(f.h.scripted.calls.at(-1)!.context)).toContain("focus on X");
  });

  it("摘要到这里：以该消息为切点压缩，之后原样保留、停在末尾", async () => {
    const f = fixture([{ text: "one" }, { text: "two" }, { text: "three" }, summary]);
    await f.h.session.prompt("first");
    await f.h.session.prompt("second");
    await f.h.session.prompt("third");
    const leaf = f.h.manager.leafId();
    const target = f.h.session.rewindPoints()[1]!;
    const result = await f.h.session.summarizeUpTo(target.entryId);
    expect(result.firstKeptEntryId).toBe(target.entryId);
    const compaction = f.h.manager.branch().at(-1)!;
    expect(compaction).toMatchObject({ type: "compaction", firstKeptEntryId: target.entryId });
    expect(compaction.parentId).toBe(leaf);
    const users = f.h.session.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual(["second", "third"]);
  });

  it("不在活动路径上的条目 → invalid_arguments", async () => {
    const f = fixture([{ text: "one" }]);
    await f.h.session.prompt("first");
    await expect(f.h.session.summarizeUpTo("nope")).rejects.toMatchObject({
      code: "invalid_arguments",
    });
  });
});

describe("中断即撤回（§3.6）真值表", () => {
  async function aborted(step: ScriptStep, options: Partial<HarnessOptions> = {}) {
    const f = fixture([step], options);
    const running = f.h.session.prompt("please");
    await new Promise((r) => setTimeout(r, 20));
    await f.h.session.abort();
    await running;
    return f;
  }

  it("中断且无任何输出 → 可撤回；撤回后对话回到之前并回填原消息", async () => {
    const f = await aborted({ kind: "hang" });
    expect(f.h.session.canUndoAbortedTurn()).toBe(true);
    const draft = await f.h.session.undoAbortedTurn();
    expect(draft).toEqual({ text: "please" });
    expect(f.h.session.messages.some((m) => m.role === "user")).toBe(false);
    expect(f.h.session.canUndoAbortedTurn()).toBe(false);
  });

  it("已有文本 / 已有工具调用 → 不撤回", async () => {
    expect((await aborted({ kind: "hang", text: "partial" })).h.session.canUndoAbortedTurn()).toBe(
      false,
    );
    home?.cleanup();
    const withCall = await aborted({
      kind: "hang",
      toolCalls: [{ name: "read", args: { path: "a.txt" } }],
    });
    expect(withCall.h.session.canUndoAbortedTurn()).toBe(false);
  });

  it("ui.restoreOnCancel=false → 不撤回", async () => {
    const f = await aborted({ kind: "hang" }, { restoreOnCancel: false });
    expect(f.h.session.canUndoAbortedTurn()).toBe(false);
    expect(await f.h.session.undoAbortedTurn()).toBeUndefined();
  });

  it("正常结束、没有回合、运行中 → 不撤回", async () => {
    const f = fixture([{ text: "fine" }, { kind: "hang" }]);
    expect(f.h.session.canUndoAbortedTurn()).toBe(false);
    await f.h.session.prompt("ok");
    expect(f.h.session.canUndoAbortedTurn()).toBe(false);
    const running = f.h.session.prompt("wait");
    await new Promise((r) => setTimeout(r, 20));
    expect(() => f.h.session.canUndoAbortedTurn()).not.toThrow();
    expect(f.h.session.canUndoAbortedTurn()).toBe(false);
    await f.h.session.abort();
    await running;
  });
});
