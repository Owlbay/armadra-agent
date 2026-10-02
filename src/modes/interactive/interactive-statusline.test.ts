/**
 * 底部信息行接线（第五波 §1）：full 两行帧黄金、Ctrl+G 与 /statusline 切换、流式后速率行、
 * 缺省布局与 PROFILE_DEFAULTS、W5-I / W5-H1 的提示文本。[W5-A]
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import type { Runtime } from "../../cli/runtime.js";
import { IMAGE_OMITTED_FOR_BUDGET } from "../../compaction/image-budget.js";
import { mergeBaseLayers } from "../../config/merge.js";
import { plainTheme } from "../../tui.js";
import { ImageBudgetNotices, compactionErrorText } from "./event-notices.js";
import { StatusArea } from "./status-area.js";
import { cleanupStarted, golden, snapshot, start } from "./test-support.js";

afterEach(cleanupStarted);

/** 视口里最后几行非空行。 */
function tail(terminal: { viewport(): string[] }, n: number): string[] {
  const rows = terminal.viewport().map((row) => row.replace(/\s+$/, ""));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows.slice(-n);
}

describe("底部信息行（交互界面）", () => {
  for (const [columns, rows] of [
    [80, 24],
    [40, 16],
  ] as const) {
    it(`full ${columns}x${rows}：状态栏上方多一行速率行，状态栏仍是最后一行`, async () => {
      const s = await start([], { columns, rows, statusLine: "full" });
      const [rate, bar] = tail(s.terminal, 2);
      expect(rate).toMatch(/^tps: — +\[-\]$/);
      expect(bar).toMatch(/^Manual/);
      golden(`status-frame-full-${columns}x${rows}`, snapshot(s.terminal, "status full"));
      s.handle.exit(0);
      await s.done;
    });
  }

  it("Ctrl+G 在 full / compact 间切换并提示；/statusline [full|compact] 同样，参数不对报用法", async () => {
    const s = await start([], { statusLine: "full" });
    s.type("\x07");
    expect(s.handle.area.layout()).toBe("compact");
    const [hint, bar] = tail(s.terminal, 2);
    expect(hint).toBe("状态栏：精简（一行）");
    expect(bar).toMatch(/^Manual · shift\+tab 切换 +echo · medium · ctx 0% · work · 0s$/);
    expect(s.terminal.viewport().join("\n")).not.toContain("[-]");
    s.type("\x07");
    expect(s.handle.area.layout()).toBe("full");
    s.type("/statusline compact\r");
    await new Promise((resolve) => setImmediate(resolve));
    s.frame();
    expect(s.handle.area.layout()).toBe("compact");
    expect(s.terminal.viewport().join("\n")).toContain("状态栏：精简（一行）");
    s.type("/statusline\r");
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.handle.area.layout()).toBe("full");
    s.type("/statusline tall\r");
    await new Promise((resolve) => setImmediate(resolve));
    s.frame();
    expect(s.terminal.viewport().join("\n")).toContain("用法：/statusline [full|compact]");
    expect(s.handle.area.layout()).toBe("full");
    s.handle.exit(0);
    await s.done;
  });

  it("一次回复之后：速率行有请求速率与 ttft，状态栏有费用与时长", async () => {
    const s = await start([{ text: "hello back", usage: { input: 900, output: 17 } }], {
      statusLine: "full",
    });
    s.type("hi\r");
    await s.until((e) => e.type === "agent_settled");
    const [rate, bar] = tail(s.terminal, 2);
    // 假供应商整块到达：没有速率（tps —），但有输出量与 ttft
    expect(rate).toMatch(
      /^tps: — • 17 tok \/ [\d.]+s \(ttft [\d.]+s\) +↑900 ↓17 · cache — · \[-\]$/,
    );
    expect(bar).toMatch(/ echo medium \| Ctx \d+\.\d% \| work \| \$0\.001 \| 0s$/);
    s.handle.exit(0);
    await s.done;
  });
});

describe("StatusArea", () => {
  const runtime = (statusLine?: "full" | "compact"): Runtime =>
    ({
      config: { ui: statusLine === undefined ? {} : { statusLine } },
    }) as unknown as Runtime;
  const session = {
    state: { cwd: "/nonexistent/ama-status", permissionMode: "default", thinkingLevel: "off" },
    getStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    getTools: () => [],
  } as unknown as AgentSession;

  it("缺省 full；配置 compact；PROFILE_DEFAULTS（嵌入宿主）给 compact，项目级仍可覆盖", () => {
    const make = (rt: Runtime): StatusArea =>
      new StatusArea({
        runtime: rt,
        theme: plainTheme(),
        session: () => session,
        now: () => 0,
        render: () => undefined,
      });
    const a = make(runtime());
    expect(a.layout()).toBe("full");
    expect(make(runtime("compact")).layout()).toBe("compact");
    expect(mergeBaseLayers({ hasProfile: true }).config.ui?.statusLine).toBe("compact");
    expect(mergeBaseLayers({}).config.ui?.statusLine).toBeUndefined();
    expect(a.toggle()).toBe("compact");
    a.dispose();
  });

  it("telemetry_tick 只重取统计（返回 true）；会话切换后时长重新起算", () => {
    let now = 0;
    let stats = 0;
    const counted = {
      ...session,
      getStats: () => {
        stats++;
        return session.getStats();
      },
    } as unknown as AgentSession;
    const area = new StatusArea({
      runtime: runtime(),
      theme: plainTheme(),
      session: () => counted,
      now: () => now,
      render: () => undefined,
    });
    const before = stats;
    expect(area.onEvent({ type: "telemetry_tick" })).toBe(true);
    expect(stats).toBe(before + 1);
    expect(area.onEvent({ type: "agent_settled" } as SessionEvent)).toBe(false);
    now = 90_000;
    expect(area.bar.render(80)[0]).toContain("| 1m");
    area.rebind();
    expect(area.bar.render(80)[0]).toContain("| 0s");
    area.dispose();
  });
});

describe("转来的提示文本", () => {
  it("[W5-H1] compaction did not shrink → 中文说明；其它错误原样", () => {
    expect(compactionErrorText("compaction did not shrink the context (100 → 120 tokens)")).toBe(
      "压缩后上下文没有变小，已保留原对话（不写摘要）",
    );
    expect(compactionErrorText("boom")).toBe("boom");
  });

  it("[W5-I] 同一轮的 image_budget 降级合并成一条，按占位数计张数；其它 context_edit 不提示", async () => {
    const shown: string[] = [];
    const notices = new ImageBudgetNotices((text) => shown.push(text));
    const edit = (replacement: string, reason = "image_budget"): SessionEvent =>
      ({
        type: "entry_appended",
        entry: { type: "context_edit", targetId: "t", replacement, reason },
      }) as unknown as SessionEvent;
    notices.onEvent(edit(`look\n${IMAGE_OMITTED_FOR_BUDGET}\n${IMAGE_OMITTED_FOR_BUDGET}`));
    notices.onEvent(edit(IMAGE_OMITTED_FOR_BUDGET));
    notices.onEvent(edit("x", "prune"));
    await Promise.resolve();
    expect(shown).toEqual(["已省略 3 张早期图片以符合请求上限"]);
  });
});
