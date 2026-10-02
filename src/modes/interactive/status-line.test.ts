/**
 * 底部信息行（第五波 §1）：速率行 + 状态栏的 full / compact 布局、丢弃顺序、ASCII、40 列不抖动。[W5-A]
 */

import { describe, expect, it } from "vitest";
import type { AgentSession, SessionStats } from "../../agent/types.js";
import type { SessionTelemetry } from "../../agent/types-w5.js";
import type { StatusLineMode } from "../../config/types.js";
import type { GitInfo } from "../../git/info.js";
import { plainTheme, visibleWidth, type Theme } from "../../tui.js";
import { StatusBar, formatDuration, statusCost, type StatusBarSource } from "./status-bar.js";
import { StatusLine, formatRate, formatSeconds } from "./status-line.js";
import { golden, lines } from "./test-support.js";

const HOUR = 3_600_000;

const pad = (row: string, width: number): string =>
  row + " ".repeat(Math.max(0, width - visibleWidth(row)));

const DONE: SessionTelemetry = {
  sessionStartedAt: 0,
  avgTps: 100,
  last: {
    requestAt: 0,
    firstTokenAt: 1_400,
    ttftMs: 1_400,
    doneAt: 6_900,
    outputTokens: 546,
    tps: 546 / 5.5,
  },
};

function stats(partial: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionId: "s",
    sessionFile: undefined,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    tokens: { input: 2_000, output: 1_200, cacheRead: 10_000, cacheWrite: 300, total: 0 },
    cost: 0.26,
    contextTokens: 6_000,
    contextWindow: 200_000,
    contextPercent: 3,
    cache: {
      reporting: "reported",
      lastHitRate: 0.83,
      reBilledTokens: 0,
      misses: { count: 0, byReason: {} },
      warming: { mode: "streaming", state: "scheduled", nextWarmAt: 1 },
    },
    telemetry: DONE,
    ...partial,
  };
}

interface Rig {
  bar: StatusBar;
  line: StatusLine;
  rows(width: number): string[];
  set(next: Partial<SessionStats>): void;
}

function rig(
  layout: StatusLineMode,
  options: {
    theme?: Theme;
    stats?: Partial<SessionStats>;
    git?: GitInfo | undefined | null;
    source?: Partial<StatusBarSource>;
  } = {},
): Rig {
  let current = stats(options.stats);
  const session = {
    state: {
      model: { provider: "anthropic", id: "claude-opus-5-5" },
      thinkingLevel: "medium",
      permissionMode: "default",
    },
    getStats: () => current,
  } as unknown as AgentSession;
  const info =
    options.git === null
      ? undefined
      : (options.git ?? { branch: "main", shortHead: "5ae9e54", insertions: 12, deletions: 3 });
  const source: StatusBarSource = {
    session: () => session,
    preset: () => "default",
    layout: () => layout,
    now: () => 2 * HOUR + 24 * 60_000,
    git: () => ({ dir: "vitaweave", info }),
    ...options.source,
  };
  const theme = options.theme ?? plainTheme();
  const bar = new StatusBar(source, theme);
  const line = new StatusLine(bar, source, theme);
  return {
    bar,
    line,
    rows: (width) => [...lines(line, width), ...lines(bar, width)],
    set(next) {
      current = stats(next);
      bar.refresh();
    },
  };
}

describe("格式化", () => {
  it("速率、耗时、会话时长", () => {
    expect(formatRate(99.27)).toBe("99");
    expect(formatRate(3.14)).toBe("3.1");
    expect(formatSeconds(5_500)).toBe("5.5s");
    expect(formatSeconds(65_000)).toBe("1m05s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration(2 * HOUR + 24 * 60_000)).toBe("2h24m");
  });

  it("[W5-E] 费用计入外部 Agent 的美元用量，其它单位不计", () => {
    const s = stats({
      cost: 0.1,
      external: {
        byAgent: {
          claude: { runs: 1, unit: "usd", amount: 0.16 },
          codex: { runs: 2, unit: "tokens", amount: 50_000 },
        },
      },
    });
    expect(statusCost(s)).toBeCloseTo(0.26, 10);
    expect(statusCost(stats({ cost: undefined }))).toBeUndefined();
    const r = rig("full", { stats: s });
    expect(r.rows(200)[1]).toContain("· $0.26 ·");
  });
});

describe("速率行", () => {
  it("full：两行；宽屏全部显示，模型与思考级别同组以空格相连，ctx 一位小数", () => {
    const r = rig("full");
    const [top, bottom] = r.rows(200);
    expect(top).toMatch(
      /^tps 99 tok\/s · 546 tok \/ 5\.5s · avg 100 · ttft 1\.4s {4,}↑12k ↓1\.2k · cache 83% ♨ · \[-\]$/,
    );
    expect(bottom).toMatch(
      /^Manual · shift\+tab 切换 {4,}anthropic\/claude-opus-5-5 medium · ctx ▯+ 3% · vitaweave ⎇ main 5ae9e54 \+12 −3 · \$0\.26 · 2h24m$/,
    );
    expect(r.rows(99)[1]).toContain("claude-opus-5-5 medium · ctx 3.0% ·");
  });

  it("compact：只有一行（速率行不占行，没有 [-]），用量类项回到状态栏", () => {
    const r = rig("compact");
    expect(lines(r.line, 120)).toEqual([]);
    const rows = r.rows(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(
      /^Manual · shift\+tab 切换 {4,}anthropic\/claude-opus-5-5 · medium · ↑12k ↓1\.2k · cache 83% ♨ · \$0\.26 · ctx ▯+ 3% · vitaweave ⎇ main 5ae9e54 \+12 −3 · 2h24m$/,
    );
    expect(rows[0]).not.toContain("[-]");
  });

  it("流式中：tps 用窗口瞬时值，tok / 耗时是本次进行中的，ttft 是当前请求的；还没有请求时 tps —", () => {
    const r = rig("full", {
      stats: {
        telemetry: {
          sessionStartedAt: 0,
          avgTps: 80,
          live: { tps: 123.4, outputTokens: 1_234, elapsedMs: 9_870 },
          last: { requestAt: 0, firstTokenAt: 900, ttftMs: 900 },
        },
      },
    });
    expect(r.rows(200)[0]).toMatch(/^tps 123 tok\/s · 1\.2k tok \/ 9\.9s · avg 80 · ttft 0\.9s /);
    r.set({ telemetry: { sessionStartedAt: 0 } });
    expect(r.rows(200)[0]).toMatch(/^tps — {4,}↑12k/);
    const tagged = Object.assign(Object.create(plainTheme()) as Theme, {
      fg: (c: string, t: string) => `<${c}>${t}`,
    });
    const live = rig("full", {
      theme: tagged,
      stats: {
        telemetry: { sessionStartedAt: 0, live: { tps: 5, outputTokens: 5, elapsedMs: 1_000 } },
      },
    });
    expect(live.line.render(200)[0]).toContain("<accent>tps");
    expect(rig("full", { theme: tagged }).line.render(200)[0]).toContain("<dim>tps");
  });

  it("速率行丢弃顺序：tok/耗时 → codemode → queue → token → cache → rebill → 预设 → 宿主 → avg → ttft；tps 与 [-] 不丢", () => {
    const base = stats();
    const r = rig("full", {
      stats: {
        cache: { ...base.cache!, reBilledTokens: 1_000, reBilledUsd: 0.05 },
      },
      source: {
        codemode: () => "on",
        preset: () => "codemode",
        hostStatus: () => new Map([["h", "x"]]),
      },
    });
    r.bar.setQueue(1, 0);
    const at = (w: number): string => r.rows(w)[0]!.replace(/ {4,}/, " ‖ ");
    expect(at(200)).toBe(
      "tps 99 tok/s · 546 tok / 5.5s · avg 100 · ttft 1.4s ‖ ↑12k ↓1.2k · cache 83% ♨ · rebill $0.05 · queue 1 · codemode on · preset codemode · [x] · [-]",
    );
    expect(at(130)).toBe(
      "tps 99 tok/s · avg 100 · ttft 1.4s ‖ ↑12k ↓1.2k · cache 83% ♨ · rebill $0.05 · queue 1 · preset codemode · [x] · [-]",
    );
    expect(at(100)).toBe(
      "tps 99 tok/s · avg 100 · ttft 1.4s ‖ cache 83% ♨ · rebill $0.05 · preset codemode · [x] · [-]",
    );
    expect(at(70)).toBe("tps 99 tok/s · avg 100 · ttft 1.4s ‖ preset codemode · [x] · [-]");
    expect(at(52)).toBe("tps 99 tok/s · avg 100 · ttft 1.4s ‖ [x] · [-]");
    expect(at(46)).toBe("tps 99 tok/s · avg 100 · ttft 1.4s ‖ [-]");
    expect(at(38)).toBe("tps 99 tok/s · ttft 1.4s ‖ [-]");
    expect(at(28)).toBe("tps 99 tok/s ‖ [-]");
  });

  it("状态行（full）丢弃顺序：思考 → 增删 → 目录 → 分支 → 时长 → 费用 → ctx → 模型；模式不丢", () => {
    const r = rig("full");
    const at = (w: number): string => r.rows(w)[1]!.replace(/ {4,}/, " ‖ ");
    expect(at(99)).toBe(
      "Manual ‖ claude-opus-5-5 medium · ctx 3.0% · vitaweave ⎇ main 5ae9e54 +12 −3 · $0.26 · 2h24m",
    );
    expect(at(90)).toBe(
      "Manual ‖ claude-opus-5-5 · ctx 3.0% · vitaweave ⎇ main 5ae9e54 +12 −3 · $0.26 · 2h24m",
    );
    expect(at(80)).toBe("Manual ‖ claude-opus-5-5 · ctx 3.0% · ⎇ main 5ae9e54 · $0.26 · 2h24m");
    expect(at(60)).toBe("Manual ‖ claude-opus-5-5 · ctx 3.0% · $0.26 · 2h24m");
    expect(at(50)).toBe("Manual ‖ claude-opus-5-5 · ctx 3.0% · $0.26");
    expect(at(40)).toBe("Manual ‖ claude-opus · ctx 3.0%");
    expect(at(24)).toBe("Manual ‖ claude-opus");
    expect(at(10)).toBe("Manual");
  });

  it("git：detached 只显示短提交；非 git 目录整段只剩目录名；拿不到增删时不显示", () => {
    expect(rig("compact", { git: { shortHead: "5ae9e54" } }).rows(200)[0]).toContain(
      "· vitaweave ⎇ 5ae9e54 · 2h24m",
    );
    expect(rig("compact", { git: null }).rows(200)[0]).toContain("· vitaweave · 2h24m");
    expect(rig("compact", { git: { branch: "trunk" } }).rows(200)[0]).toContain(
      "· vitaweave ⎇ trunk · 2h24m",
    );
  });

  it("40 列不抖动：数值变化时行数、宽度与显示的项不变", () => {
    const shapes = new Set<string>();
    for (const [tps, tokens, ms] of [
      [3.2, 12, 900],
      [99, 546, 5_500],
      [250, 1_234, 9_870],
      [999, 9_999, 59_900],
    ] as const) {
      const r = rig("full", {
        stats: {
          telemetry: {
            sessionStartedAt: 0,
            avgTps: tps,
            live: { tps, outputTokens: tokens, elapsedMs: ms },
            last: { requestAt: 0, firstTokenAt: 100, ttftMs: ms / 10 },
          },
        },
      });
      const rows = r.rows(40);
      expect(rows).toHaveLength(2);
      for (const row of r.line.render(40).concat(r.bar.render(40)))
        expect(visibleWidth(row)).toBeLessThanOrEqual(40);
      shapes.add(rows.map((row) => row.replace(/[\d.]+/g, "N").replace(/ +/g, " ")).join("\n"));
    }
    expect(shapes.size).toBe(1);
  });

  it("帧黄金：40 / 60 / 80 / 110 列 × full / compact", () => {
    const out: string[] = [];
    for (const layout of ["full", "compact"] as const) {
      const r = rig(layout);
      for (const w of [40, 60, 80, 110]) {
        out.push(`# ${layout} ${w}`, ...r.rows(w).map((row) => `|${pad(row, w)}|`));
      }
    }
    golden("status-layouts", out.join("\n") + "\n");
  });

  it("帧黄金：ASCII（⎇ → git、− → -、♨ → ~）", () => {
    const theme = plainTheme({ ascii: true });
    const out: string[] = [];
    for (const layout of ["full", "compact"] as const) {
      const r = rig(layout, { theme });
      for (const w of [80, 140]) {
        out.push(`# ${layout} ${w}`, ...r.rows(w).map((row) => `|${pad(row, w)}|`));
      }
    }
    const text = out.join("\n") + "\n";
    expect(text).not.toMatch(/[⎇−♨↑↓]/);
    expect(text).toContain("vitaweave git main 5ae9e54 +12 -3");
    golden("status-ascii", text);
  });
});
