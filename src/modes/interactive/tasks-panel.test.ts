import { afterEach, describe, expect, it } from "vitest";
import {
  subagentRegistryFor,
  type RegistryHost,
  type SubagentRegistry,
} from "../../agent/subagent-registry.js";
import { AgentCatalog } from "../../agents/catalog.js";
import type { SessionEntry } from "../../session/types.js";
import type { TaskInfo } from "../../tools/types.js";
import { Container, MemoryTerminal, TUI, plainTheme, type Component } from "../../tui.js";
import { agentsPanel, taskOutputPanel } from "./agent-panels.js";
import { openPicker } from "./pickers.js";
import {
  agentFacts,
  describeAgents,
  describeTaskOutput,
  describeTasks,
  taskLine,
} from "./tasks-report.js";
import { golden, lines, usage } from "./test-support.js";

const theme = plainTheme();
const NOW = 1_000_000;

function taskEntry(info: TaskInfo, n: number): SessionEntry {
  return {
    type: "custom",
    id: `e${n}`,
    parentId: null,
    timestamp: "2026-10-03T00:00:00.000Z",
    customType: "ama.task",
    data: { ...info, parentToolCallId: `c${n}`, cwd: "/w" },
  } as SessionEntry;
}

const TASKS: TaskInfo[] = [
  {
    taskId: "t1",
    agent: "explore",
    runner: "ama",
    description: "找出 src/tui 的测试缺口",
    background: true,
    status: "completed",
    startedAt: NOW - 125_000,
    endedAt: NOW - 20_000,
    turns: 7,
    usage: usage({ input: 2000, cacheRead: 10_300, output: 4100 }),
    costUsd: 0.034,
  },
  {
    taskId: "t2",
    agent: "claude",
    runner: "claude",
    description: "审查改动",
    background: false,
    status: "failed",
    startedAt: NOW - 30_000,
    endedAt: NOW - 25_000,
  },
];

let registry: SubagentRegistry | undefined;
afterEach(() => {
  registry?.dispose();
  registry = undefined;
});

function withTasks(sessionId = "s-tasks"): SubagentRegistry {
  const host = {
    manager: { id: sessionId, branch: () => TASKS.map((t, i) => taskEntry(t, i + 1)) },
    cwd: "/w",
    emit: () => undefined,
    appendEntry: () => undefined,
    outputDir: undefined,
    log: () => undefined,
    options: {},
  } as unknown as RegistryHost;
  registry = subagentRegistryFor(host, { catalog: new AgentCatalog(), now: () => NOW });
  return registry;
}

function screen(component: Component, columns: number, rows = 16): string {
  const terminal = new MemoryTerminal({ columns, rows });
  const tui = new TUI(terminal);
  const box = new Container();
  box.addChild(component);
  tui.addChild(box);
  tui.start();
  tui.renderNow();
  const out = [`# viewport ${columns}x${rows}`, ...terminal.viewport().map((l) => `|${l}`)];
  tui.stop();
  return out.join("\n") + "\n";
}

describe("/tasks", () => {
  it("一行：类型、状态、耗时、轮数、用量、费用、后台、描述", () => {
    expect(taskLine(TASKS[0]!, NOW)).toBe(
      "t1  explore · 完成 · 1m45s · 7 轮 · ↑12.3k ↓4.1k · $0.03 · 后台  找出 src/tui 的测试缺口",
    );
    expect(taskLine(TASKS[1]!, NOW)).toBe("t2  claude · 失败 · 5.0s  审查改动");
  });

  it("line 模式文本：列表与单个任务输出；没有任务", () => {
    expect(describeTasks("none", NOW)).toBe("还没有子 Agent 任务");
    withTasks();
    const text = describeTasks("s-tasks", NOW);
    expect(text.split("\n")[0]).toBe("子 Agent 任务（2）：");
    expect(text).toContain("/tasks <id> 查看输出 · /tasks stop <id> 停止");
    expect(describeTaskOutput("s-tasks", "t1", NOW)).toContain("（还没有输出）");
    expect(describeTaskOutput("s-tasks", "t9", NOW)).toBe("没有任务 t9");
  });

  for (const columns of [80, 40]) {
    it(`选择器 ${columns}x16（新的在上）`, async () => {
      withTasks();
      const terminal = new MemoryTerminal({ columns, rows: 16 });
      const tui = new TUI(terminal);
      tui.start();
      const picked = openPicker(
        {
          theme,
          showOverlay: (c, o) => tui.showOverlay(c, o),
          columns: () => columns,
        },
        {
          title: "子 Agent 任务",
          items: [...TASKS]
            .reverse()
            .map((task) => ({ value: task.taskId, label: taskLine(task, NOW) })),
          footer: "↑↓ 选择 · Enter 查看 · Esc 取消",
        },
      );
      tui.renderNow();
      const shot = [
        `# tasks picker · viewport ${columns}x16`,
        ...terminal.viewport().map((l) => `|${l}`),
      ].join("\n");
      golden(`tasks-picker-${columns}x16`, shot + "\n");
      terminal.sendInput("\r");
      tui.renderNow();
      expect((await picked)?.value).toBe("t2");
      tui.stop();
    });
  }

  it("任务输出面板", () => {
    const panel = taskOutputPanel(
      TASKS[0]!,
      "缺口主要在 overlay.ts\n与 editor 的粘贴折叠",
      theme,
      NOW,
    );
    golden("tasks-output-80x16", screen(panel, 80));
    expect(lines(panel, 80)[0]).toBe(
      "▎ 任务 t1  explore · 完成 · 1m45s · 7 轮 · ↑12.3k ↓4.1k · $0.03 · 后台",
    );
  });
});

describe("/agents", () => {
  it("类型表：内置类型与外部 Agent 的安装状态", () => {
    expect(
      agentFacts({
        name: "claude",
        description: "",
        runner: "claude",
        source: "builtin",
        installed: true,
        version: "2.1.0",
      }),
    ).toEqual(["claude", "内置", "已安装 2.1.0"]);
    expect(
      agentFacts({
        name: "codex",
        description: "",
        runner: "codex",
        source: "builtin",
        installed: false,
      }),
    ).toEqual(["codex", "内置", "未安装"]);
    expect(describeAgents("none")).toBe("当前会话没有子 Agent（task 工具未启用）");
    withTasks("s-agents");
    const text = describeAgents("s-agents");
    expect(text).toContain("general");
    expect(text).toContain("explore");
  });

  for (const columns of [80, 40]) {
    it(`面板 ${columns} 列`, () => {
      withTasks("s-agents");
      golden(`agents-panel-${columns}x16`, screen(agentsPanel("s-agents", theme), columns));
    });
  }
});
