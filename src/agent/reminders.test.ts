import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir } from "../../test/helpers/tool-context.js";
import { jobsForSession } from "../tools/background-jobs.js";
import { createTodoTool } from "../tools/todo.js";
import { createLimitsExtension } from "./limits.js";
import {
  REMINDER_CUSTOM_TYPE,
  createRemindersExtension,
  remindersSettings,
  type RemindersDeps,
  type RemindersSettings,
} from "./reminders.js";
import { createHarness, type HarnessOptions } from "./testing/harness.js";
import type { ScriptStep } from "./testing/scripted-api.js";
import { fakeModel, stubTool } from "./testing/stubs.js";

const ls = stubTool({ name: "ls", properties: { n: { type: "integer" } } });
const read = stubTool({ name: "read", properties: { path: { type: "string" } } });
const edit = stubTool({
  name: "edit",
  properties: { path: { type: "string" } },
  permission: "write",
});
const bash = stubTool({ name: "bash", properties: { command: { type: "string" } } });
const lsStep = (n: number): ScriptStep => ({ toolCalls: [{ name: "ls", args: { n } }] });

function withReminders(
  script: ScriptStep[],
  settings: RemindersSettings = {},
  deps: RemindersDeps = {},
  extra: Partial<HarnessOptions> = {},
) {
  return createHarness({
    script,
    tools: [ls, read, edit, bash, createTodoTool()],
    extensions: [
      ({ core }) => createLimitsExtension(core, core.options.limits),
      ({ core }) => createRemindersExtension(core, settings, deps),
    ],
    ...extra,
  });
}

const resultTexts = (h: ReturnType<typeof createHarness>): string[] =>
  h.session.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => (m.role === "toolResult" ? String(m.content) : ""));

const reminderEntries = (h: ReturnType<typeof createHarness>) =>
  h.session.entries.filter(
    (e) => e.type === "custom_message" && e.customType === REMINDER_CUSTOM_TYPE,
  );

let tmp: { dir: string; cleanup(): void } | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

describe("remindersSettings", () => {
  it("取 reminders.* 与 todo.reminder", () => {
    expect(remindersSettings({})).toEqual({});
    expect(remindersSettings({ reminders: { todo: false }, todo: { reminder: 3 } })).toEqual({
      reminders: { todo: false },
      todoEvery: 3,
    });
  });
});

describe("提醒通道（W5-H2 H3）", () => {
  const todoSet: ScriptStep = {
    toolCalls: [
      {
        name: "todo",
        args: {
          action: "set",
          items: [
            { id: "1", text: "first", status: "done" },
            { id: "2", text: "second", status: "pending" },
          ],
        },
      },
    ],
  };

  it("todo 复述：连续 N 次回复未更新且有未完成项 → 批次尾部提醒一次，计数清零", async () => {
    const h = withReminders(
      [todoSet, lsStep(1), lsStep(2), lsStep(3), lsStep(4), lsStep(5), lsStep(6), { text: "ok" }],
      { todoEvery: 3 },
    );
    await h.session.prompt("go");
    const texts = resultTexts(h);
    const hits = texts.map((t, i) => (t.includes("todo list has not been updated") ? i : -1));
    // 第 0 条是 todo 结果（更新 → 计数 0）；之后第 3 次回复（索引 3）与第 6 次（索引 6）各一次
    expect(hits.filter((i) => i >= 0)).toEqual([3, 6]);
    expect(texts[3]).toContain("[ ] 2. second");
    expect(texts[3]).toMatch(/<system-reminder>[\s\S]*<\/system-reminder>$/);
  });

  it("可关：reminders.todo false / todo.reminder 0；没有未完成项不提醒", async () => {
    for (const settings of [{ reminders: { todo: false }, todoEvery: 1 }, { todoEvery: 0 }]) {
      const h = withReminders([todoSet, lsStep(1), lsStep(2), { text: "ok" }], settings);
      await h.session.prompt("go");
      expect(resultTexts(h).some((t) => t.includes("todo list"))).toBe(false);
    }
    const h = withReminders([lsStep(1), lsStep(2), { text: "ok" }], { todoEvery: 1 });
    await h.session.prompt("go");
    expect(resultTexts(h).some((t) => t.includes("todo list"))).toBe(false);
  });

  it("外部文件改动：新提示前以 custom_message 列出并附 diff --stat；本 Agent 的 edit / bash 改动不算", async () => {
    // 路径按 cwd 解析（Windows 上 /work → C:\\work）
    const A = resolve("/work", "a.ts");
    const B = resolve("/work", "b.ts");
    const stats = new Map<string, { mtimeMs: number; size: number }>([
      [A, { mtimeMs: 1, size: 10 }],
      [B, { mtimeMs: 1, size: 10 }],
    ]);
    const editB = stubTool({
      name: "edit",
      properties: { path: { type: "string" } },
      permission: "write",
      run: async () => (stats.set(B, { mtimeMs: 2, size: 11 }), { content: "ok" }),
    });
    const bashA = stubTool({
      name: "bash",
      properties: { command: { type: "string" } },
      run: async () => (stats.set(A, { mtimeMs: 5, size: 20 }), { content: "ok" }),
    });
    const h = createHarness({
      script: [
        { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
        { toolCalls: [{ name: "read", args: { path: "/work/b.ts" } }] },
        { text: "read both" },
        { toolCalls: [{ name: "edit", args: { path: "b.ts" } }] },
        { toolCalls: [{ name: "bash", args: { command: "fmt" } }] },
        { text: "edited" },
        { text: "third" },
        { text: "fourth" },
      ],
      tools: [read, editB, bashA],
      extensions: [
        ({ core }) =>
          createRemindersExtension(
            core,
            {},
            {
              stat: (p) => stats.get(p),
              diffStat: (_cwd, files) => ` ${files.join(", ")} | 2 +-`,
            },
          ),
      ],
    });
    const contents = () =>
      reminderEntries(h).map((e) => String(e.type === "custom_message" ? e.content : ""));
    await h.session.prompt("one");
    stats.set(A, { mtimeMs: 2, size: 12 }); // 用户在编辑器里改
    await h.session.prompt("two");
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toContain(`- ${A}`);
    expect(contents()[0]).not.toContain("b.ts");
    expect(contents()[0]).toContain(`git diff --stat:\n ${A} | 2 +-`);
    await h.session.prompt("three"); // edit 改 b、bash 改 a：都是本 Agent 做的
    expect(contents()).toHaveLength(1);
    stats.delete(B);
    await h.session.prompt("four");
    expect(contents()).toHaveLength(2);
    expect(contents()[1]).toContain(`- ${B} (deleted)`);
    expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(2);
  });

  it("上下文用量：70% 与 85% 各一次", async () => {
    const big = "x".repeat(4000);
    const bigTool = stubTool({ name: "ls", run: async () => ({ content: big }) });
    const h = createHarness({
      script: [lsStep(1), lsStep(2), lsStep(3), lsStep(4), { text: "ok" }],
      tools: [bigTool],
      model: fakeModel({ contextWindow: 3000 }),
      compaction: { enabled: false },
      extensions: [({ core }) => createRemindersExtension(core, {})],
    });
    await h.session.prompt("go");
    const texts = resultTexts(h);
    expect(texts.filter((t) => t.includes("Context is")).length).toBe(2);
    expect(texts.some((t) => /Context is \d+% full\. Prefer targeted/.test(t))).toBe(true);
    expect(texts.some((t) => /Context is \d+% full\. Finish the current step/.test(t))).toBe(true);
  });

  it("预算剩余 < 20%：每次运行一次；reminders.budget 可关", async () => {
    const script = [lsStep(1), lsStep(2), lsStep(3), lsStep(4), lsStep(5), { text: "ok" }];
    const h = withReminders(script, {}, {}, { limits: { maxTurns: 5 } });
    await h.session.prompt("go");
    const texts = resultTexts(h);
    expect(texts.filter((t) => t.includes("This run has used")).length).toBe(1);
    expect(texts[3]).toContain("This run has used 4 of 5 turns");
    const off = withReminders(
      script,
      { reminders: { budget: false } },
      {},
      { limits: { maxTurns: 5 } },
    );
    await off.session.prompt("go");
    expect(resultTexts(off).some((t) => t.includes("This run has used"))).toBe(false);
  });

  it("后台命令退出：background_job 事件；下次提示前通知一次；dispose 回收运行中的任务", async () => {
    tmp = makeTmpDir();
    const h = withReminders([{ text: "a" }, { text: "b" }, { text: "c" }]);
    const jobs = jobsForSession(h.manager.id);
    const quick = jobs.start("exit 2", {
      cwd: tmp.dir,
      outputPath: join(tmp.dir, "q.log"),
      spawn: (fd) =>
        spawn(process.execPath, ["-e", "process.exit(2)"], { stdio: ["ignore", fd, fd] }),
    });
    await jobs.wait(quick.id, 5000);
    await h.session.prompt("one");
    const entries = reminderEntries(h);
    expect(entries).toHaveLength(1);
    expect(String(entries[0]?.type === "custom_message" && entries[0].content)).toContain(
      "Background job bg1 (`exit 2`) exited with code 2",
    );
    await h.session.prompt("two");
    expect(reminderEntries(h)).toHaveLength(1);
    expect(
      h.events
        .filter((e) => e.type === "background_job")
        .map((e) => (e.type === "background_job" ? [e.phase, e.exitCode] : [])),
    ).toEqual([
      ["started", undefined],
      ["exited", 2],
    ]);
    const slow = jobs.start("sleep", {
      cwd: tmp.dir,
      outputPath: join(tmp.dir, "s.log"),
      spawn: (fd) =>
        spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
          stdio: ["ignore", fd, fd],
          detached: process.platform !== "win32",
        }),
    });
    await h.session.dispose();
    await jobs.wait(slow.id, 5000);
    expect(jobs.get(slow.id)?.status).toBe("stopped");
  });

  it("子会话只管后台任务：没有 beforePrompts / onEvent", () => {
    const h = createHarness({ script: [{ text: "ok" }], depth: 1 });
    const ext = createRemindersExtension(h.session, {});
    expect(ext.beforePrompts).toBeUndefined();
    expect(ext.onEvent).toBeUndefined();
    ext.dispose?.();
  });
});
