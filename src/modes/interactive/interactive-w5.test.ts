/**
 * 第五波界面接线的交互集成（MemoryTerminal + fake 供应商）：计划 → 审批框 → 执行、`/plan`、后台子 Agent
 * 在 `/tasks` 里可见、`Ctrl+V` 粘贴剪贴板图片。[W5-U]
 */

import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { cleanupStarted, golden, snapshot, start, type Started } from "./test-support.js";

afterEach(cleanupStarted);
beforeEach(() => sharedCacheReporting.clear());

const PLAN_REPLY = [
  "看过了 status-bar.ts。",
  "<proposed_plan>",
  "# 给状态栏加回退显示",
  "## 步骤",
  "- [ ] S1 读 status-bar.ts",
  "- [ ] S2 加 → 回退模型",
  "## 验证",
  "pnpm test",
  "</proposed_plan>",
].join("\n");

async function waitFor(
  s: Started,
  check: (screen: string) => boolean,
  label: string,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    s.frame();
    const screen = s.terminal.viewport().join("\n");
    if (check(screen)) return;
    if (Date.now() - started > 5000) throw new Error(`timeout: ${label}\n${screen}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const screenOf = (s: Started): string => s.terminal.viewport().join("\n");

/** 帧黄金：光标位置随渲染时机变、计划文件名带会话 id，都抹掉。 */
function shot(s: Started, label: string): string {
  return snapshot(s.terminal, label)
    .replace(/ cursor=\d+,\d+/, "")
    .replace(/plans\/([0-9a-f-]+)/g, (_m, id: string) => `plans/${"x".repeat(id.length)}`);
}

describe("计划审批（交互）", () => {
  it("plan → 审批框 → 批准（回到进入前的模式）→ 执行", async () => {
    const script: FakeResponse[] = [{ text: PLAN_REPLY }, { text: "按计划改完了" }];
    const s = await start(script, { argv: ["--permission-mode", "plan"] });
    s.type("规划一下\r");
    await waitFor(s, (x) => x.includes("计划待审批"), "plan dialog");
    golden("interactive-plan-dialog-80x24", shot(s, "plan proposed"));
    // 文本回复审批与提示行已关掉
    expect(screenOf(s)).not.toContain("回复 1 批准");
    s.type("1");
    expect(screenOf(s)).toContain("回到进入前的模式（Manual）");
    s.type("\r");
    await waitFor(s, (x) => x.includes("按计划改完了"), "execution");
    expect(s.handle.session().state.permissionMode).toBe("default");
    expect(screenOf(s)).toContain("已批准计划 v1，以 Manual 执行");
    expect(s.rt).toBeDefined();
    s.handle.exit(0);
    await s.done;
  });

  it("/plan：面板，有待审批的计划时重新打开审批框；Esc 放弃留在 Plan", async () => {
    const s = await start([{ text: PLAN_REPLY }], { argv: ["--permission-mode", "plan"] });
    s.type("规划一下\r");
    await waitFor(s, (x) => x.includes("计划待审批"), "plan dialog");
    s.terminal.sendInput("4");
    await waitFor(s, (x) => x.includes("已放弃计划 v1"), "rejected");
    expect(s.handle.session().state.permissionMode).toBe("default");
    s.type("/plan\r");
    await waitFor(s, (x) => x.includes("状态  已放弃"), "plan panel");
    golden("interactive-plan-panel-80x24", shot(s, "/plan"));
    s.handle.exit(0);
    await s.done;
  });
});

describe("子 Agent（交互）", () => {
  it("后台子 Agent 完成后有提示，/tasks 列出", async () => {
    const script: FakeResponse[] = [
      {
        steps: [
          {
            toolCall: {
              name: "task",
              arguments: {
                prompt: "找出 src/tui 的测试缺口",
                description: "找测试缺口",
                agent: "explore",
                background: true,
              },
            },
          },
        ],
      },
      { text: "好的" },
      { text: "好的" },
      { text: "收到通知" },
    ];
    const s = await start(script, {
      argv: ["--tools", "read,task", "--permission-mode", "full-auto"],
    });
    s.type("后台找一下测试缺口\r");
    await waitFor(s, (x) => x.includes("子 Agent 通知  t1 explore 完成"), "notification");
    expect(s.terminal.transcript().join("\n")).toContain("↳ t1 explore · 完成");
    await s.handle.session().waitForIdle();
    s.type("/tasks\r");
    await waitFor(s, (x) => x.includes("子 Agent 任务"), "tasks picker");
    const frame = shot(s, "/tasks").replace(/完成 · \d+(\.\d)?s/g, "完成 · <t>");
    golden("interactive-tasks-80x24", frame);
    s.type("\r");
    await waitFor(s, (x) => x.includes("任务 t1"), "task output");
    s.handle.exit(0);
    await s.done;
  });
});

describe("Ctrl+V / /paste", () => {
  it("剪贴板有图：光标处插入 @路径", async () => {
    const s = await start([], {
      clipboard: {
        platform: "darwin",
        run: async (_command, args) => {
          const file = args[args.length - 1] as string;
          writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
          return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
        },
        now: () => Date.UTC(2026, 9, 3),
      },
    });
    s.type("看这张图");
    s.terminal.sendInput("\x16");
    await waitFor(s, (x) => x.includes(".png"), "inserted");
    const text = s.handle.editor.getText();
    expect(text).toMatch(/^看这张图 @.+clipboard.+2026-10-03T00-00-00-000Z\.png $/);
    s.handle.exit(0);
    await s.done;
  });

  it("没有剪贴板命令 / 没有图：一行提示", async () => {
    const s = await start([]);
    s.terminal.sendInput("\x16");
    await waitFor(s, (x) => x.includes("没有可用的系统命令"), "no tool");
    s.handle.exit(0);
    await s.done;
    const t = await start([], {
      clipboard: {
        platform: "darwin",
        run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: "" }),
      },
    });
    t.type("/paste\r");
    await waitFor(t, (x) => x.includes("剪贴板里没有图片"), "no image");
    expect(t.handle.editor.getText()).toBe("");
    t.handle.exit(0);
    await t.done;
  });
});
