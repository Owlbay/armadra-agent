/**
 * 订阅配额行与 full 配色（第三行、compact 末尾短项、↑N ↓N、着色、NO_COLOR / ASCII、每分钟重画）。[W6]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, SessionEvent, SessionStats } from "../../agent/types.js";
import type { QuotaUpdateEvent } from "../../agent/types-w6.js";
import {
  parseQuotaHeaders,
  parseRateLimitEvent,
  parseUsagePayload,
} from "../../ai/apis/chatgpt-rate-limits.js";
import type { Runtime } from "../../cli/runtime.js";
import type { StatusLineMode } from "../../config/types.js";
import type { GitInfo } from "../../git/info.js";
import { setLocale } from "../../i18n/index.js";
import { createTheme, plainTheme, stripAnsi, visibleWidth, type Theme } from "../../tui.js";
import { StatusArea, QUOTA_TICK_MS } from "./status-area.js";
import { StatusBar, type StatusBarSource } from "./status-bar.js";
import { StatusLine } from "./status-line.js";
import { QuotaLine, formatRemaining, type QuotaView } from "./status-quota.js";
import { golden, lines } from "./test-support.js";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const QUOTA: QuotaUpdateEvent = {
  type: "quota_update",
  provider: "chatgpt",
  planType: "plus",
  primary: { usedPercent: 10, windowMinutes: 300, resetsAt: NOW + 2 * HOUR + 18 * MIN },
  secondary: { usedPercent: 31, windowMinutes: 10_080, resetsAt: NOW + 6 * 24 * HOUR + 5 * HOUR },
};

function stats(partial: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionId: "s",
    sessionFile: undefined,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    tokens: { input: 2_000, output: 1_146, cacheRead: 10_000, cacheWrite: 0, total: 0 },
    cost: 168.96,
    contextTokens: 180_000,
    contextWindow: 200_000,
    contextPercent: 90,
    telemetry: {
      sessionStartedAt: 0,
      avgTps: 119,
      last: {
        requestAt: 0,
        firstTokenAt: 11_600,
        ttftMs: 11_600,
        doneAt: 13_800,
        outputTokens: 1_146,
        tps: 520.9,
      },
    },
    ...partial,
  };
}

function session(model = { provider: "chatgpt", id: "gpt-5.5" }): AgentSession {
  return {
    state: { model, thinkingLevel: "medium", permissionMode: "default", cwd: "/tmp" },
    getStats: () => stats(),
    getTools: () => [],
  } as unknown as AgentSession;
}

const GIT: GitInfo = {
  branch: "feat/ui-redesign-v9",
  shortHead: "0dd0894",
  insertions: 0,
  deletions: 0,
  ahead: 5,
  behind: 0,
};

/** full 三行（速率行、状态栏、配额行）或 compact 一行。 */
function rows(
  width: number,
  options: { theme?: Theme; quota?: QuotaView; layout?: StatusLineMode; git?: GitInfo } = {},
): string[] {
  const theme = options.theme ?? plainTheme();
  const layout = options.layout ?? "full";
  const quota = "quota" in options ? options.quota : { quota: QUOTA };
  const source: StatusBarSource = {
    session: () => session(),
    preset: () => "default",
    layout: () => layout,
    git: () => ({ dir: "cc-switch", info: options.git ?? GIT }),
    now: () => NOW,
    sessionStartedAt: () => NOW - (21 * HOUR + 46 * MIN),
    quota: () => quota,
  };
  const bar = new StatusBar(source, theme);
  const rate = new StatusLine(bar, source, theme);
  const line = new QuotaLine({ layout: () => layout, quota: () => quota, now: () => NOW }, theme);
  return [...rate.render(width), ...bar.render(width), ...line.render(width)];
}

const plain = (list: string[]): string[] => list.map((l) => stripAnsi(l).replace(/\s+$/, ""));

afterEach(() => setLocale("zh"));

describe("配额文本", () => {
  it("相对时长：天时 / 时分 / 分；已过为 0m；tight 去空格", () => {
    expect(formatRemaining(6 * 24 * HOUR + 5 * HOUR + 59 * MIN)).toBe("6d 5h");
    expect(formatRemaining(2 * HOUR + 18 * MIN + 30_000)).toBe("2h 18m");
    expect(formatRemaining(18 * MIN)).toBe("18m");
    expect(formatRemaining(-5_000)).toBe("0m");
    expect(formatRemaining(6 * 24 * HOUR + 5 * HOUR, true)).toBe("6d5h");
  });

  it("头 / codex.rate_limits / wham 三种来源 → 同一行（百分比与重置时间）", () => {
    const sec = (ms: number): string => String(Math.floor(ms / 1000));
    const fromHeaders = parseQuotaHeaders(
      new Headers({
        "x-codex-primary-used-percent": "10",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": sec(QUOTA.primary!.resetsAt!),
        "x-codex-secondary-used-percent": "31",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": sec(QUOTA.secondary!.resetsAt!),
      }),
    );
    const fromEvent = parseRateLimitEvent({
      type: "codex.rate_limits",
      plan_type: "plus",
      rate_limits: {
        primary: {
          used_percent: 10,
          window_minutes: 300,
          reset_at: QUOTA.primary!.resetsAt! / 1e3,
        },
        secondary: {
          used_percent: 31,
          window_minutes: 10_080,
          reset_at: QUOTA.secondary!.resetsAt! / 1e3,
        },
      },
    });
    const fromWham = parseUsagePayload({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18_000,
          reset_at: QUOTA.primary!.resetsAt! / 1e3,
        },
        secondary_window: {
          used_percent: 31,
          limit_window_seconds: 604_800,
          reset_at: QUOTA.secondary!.resetsAt! / 1e3,
        },
      },
    });
    for (const snap of [fromHeaders, fromEvent, fromWham]) {
      const quota = { type: "quota_update", provider: "chatgpt", ...snap } as QuotaUpdateEvent;
      const line = new QuotaLine(
        { layout: () => "full", quota: () => ({ quota }), now: () => NOW },
        plainTheme(),
      );
      expect(lines(line, 120)).toEqual([
        "5 小时：10.0% | 重置：2h 18m | 本周：31.0% | 本周重置：6d 5h",
      ]);
    }
  });

  it("非标准窗口用实际时长作标签；只有 primary（429）时只有一组", () => {
    const quota: QuotaUpdateEvent = {
      type: "quota_update",
      provider: "chatgpt",
      primary: { usedPercent: 100, windowMinutes: 1440, resetsAt: NOW + 3 * HOUR },
    };
    const line = new QuotaLine(
      { layout: () => "full", quota: () => ({ quota }), now: () => NOW },
      plainTheme(),
    );
    expect(lines(line, 120)).toEqual(["1d：100.0% | 1d重置：3h 0m"]);
    expect(lines(line, 60)).toEqual(["1d 100% ↻3h0m"]);
  });
});

describe("配额行帧黄金", () => {
  for (const locale of ["zh", "en"] as const) {
    it(`${locale}：120 / 80 / 60 / 40 列；有配额、等首次请求、无（siwc）；ASCII`, () => {
      setLocale(locale);
      const out: string[] = [];
      for (const width of [120, 80, 60, 40]) {
        out.push(`# ${width} 有配额`, ...plain(rows(width)).map((l) => `|${l}|`));
        for (const l of rows(width)) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
      }
      out.push(
        "# 80 首次请求前（codex）",
        ...plain(rows(80, { quota: "pending" })).map((l) => `|${l}|`),
      );
      out.push(
        "# 80 无数据（siwc）",
        ...plain(rows(80, { quota: undefined })).map((l) => `|${l}|`),
      );
      const ascii = plainTheme({ ascii: true });
      out.push("# 60 ASCII", ...plain(rows(60, { theme: ascii })).map((l) => `|${l}|`));
      for (const width of [200, 120]) {
        const compact = plain(rows(width, { layout: "compact" }));
        out.push(`# ${width} compact`, ...compact.map((l) => `|${l}|`));
      }
      golden(`${locale === "en" ? "en/" : ""}status-quota-widths`, out.join("\n") + "\n");
    });
  }

  it("NO_COLOR：结构不变、没有转义序列；siwc 无数据不占行", () => {
    const noColor = createTheme("dark", { caps: { colors: 0 }, ascii: false });
    const out = rows(120, { theme: noColor });
    expect(out).toHaveLength(3);
    for (const l of out) expect(l).not.toContain("\x1b[3");
    expect(plain(out)).toEqual(plain(rows(120)));
    expect(rows(120, { quota: undefined })).toHaveLength(2);
  });

  it("compact：既有记号顺序不变，只在末尾追加短配额项，宽度不够最先丢", () => {
    const [withQuota] = plain(rows(200, { layout: "compact" }));
    const [without] = plain(rows(200, { layout: "compact", quota: undefined }));
    const gap = (l: string | undefined): string => (l ?? "").replace(/ {4,}/, " ‖ ");
    expect(gap(withQuota)).toBe(`${gap(without)} · 5h 10% 周 31%`);
    expect(without).not.toContain("↑5");
    expect(plain(rows(80, { layout: "compact" }))[0]).not.toContain("5h");
    expect(rows(200, { layout: "compact", quota: "pending" })[0]).toBe(
      rows(200, { layout: "compact", quota: undefined })[0],
    );
  });
});

describe("配色（深色 truecolor 带 ANSI 的黄金 + 语义色断言）", () => {
  const tagged = Object.assign(Object.create(plainTheme()) as Theme, {
    fg: (c: string, t: string) => `<${c}>${t}</>`,
  });

  it("语义色：标签与分隔 dim，数值按参考着色", () => {
    const [rate, bar, quota] = rows(600, { theme: tagged });
    expect(rate).toContain("<dim>tps:</> <tool>521</><dim> tok/s</>");
    expect(rate).toContain("<accent>1.1k</><dim> tok / </><accent>2.2s</>");
    expect(rate).toContain("<dim>avg </><accent>119</>");
    expect(rate).toContain("<dim>ttft </><tool>11.6s</>");
    expect(bar).toContain("<accent>chatgpt/gpt-5.5</>");
    expect(bar).toContain("<user>medium</>");
    expect(bar).toContain("<dim>Ctx </><error>90.0%</>");
    expect(bar).toContain(
      "<success>cc-switch</><dim> </><dim>⎇</> <success>feat/ui-redesign-v9</> <dim>0dd0894</> <code>↑5</>",
    );
    expect(bar).toContain("<dim>(</><success>+0</><dim>,</><error>-0</><dim>)</>");
    expect(bar).toContain("<warning>$168.96</>");
    expect(bar).toContain("<tool>21h46m</>");
    expect(quota).toBe(
      "<dim>5 小时：</><success>10.0%</><dim> | </><dim>重置：</><tool>2h 18m</><dim> | </>" +
        "<dim>本周：</><success>31.0%</><dim> | </><dim>本周重置：</><tool>6d 5h</>",
    );
    const behind = rows(600, { theme: tagged, git: { ...GIT, ahead: 0, behind: 3 } })[1]!;
    expect(behind).toContain("<error>↓3</>");
    expect(behind).not.toContain("↑0");
  });

  it("配额高阈值：≥ 70% warning、≥ 90% error", () => {
    const high: QuotaUpdateEvent = {
      ...QUOTA,
      primary: { ...QUOTA.primary!, usedPercent: 95 },
      secondary: { ...QUOTA.secondary!, usedPercent: 75 },
    };
    const [, , quota] = rows(600, { theme: tagged, quota: { quota: high } });
    expect(quota).toContain("<error>95.0%</>");
    expect(quota).toContain("<warning>75.0%</>");
  });

  it("深色 truecolor 黄金；16 色退化与浅色主题都着色", () => {
    const dark = createTheme("dark", { caps: { colors: 16_777_216 }, ascii: false });
    const esc = (l: string): string => l.replaceAll("\x1b", "\\e");
    golden("status-quota-dark-ansi", rows(120, { theme: dark }).map(esc).join("\n") + "\n");
    const ansi16 = rows(120, {
      theme: createTheme("dark", { caps: { colors: 16 }, ascii: false }),
    });
    expect(ansi16.join("\n")).toContain("\x1b[95m"); // tool → 亮紫
    expect(ansi16.join("\n")).toContain("\x1b[92m"); // success → 亮绿
    const light = rows(120, {
      theme: createTheme("light", { caps: { colors: 256 }, ascii: false }),
    });
    expect(plain(light)).toEqual(plain(rows(120)));
    expect(light[2]).toContain("\x1b[38;5;");
  });
});

describe("StatusArea：配额来源与每分钟重画", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ama-quota-"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function area(backend: "codex" | "siwc" | undefined, provider = "chatgpt") {
    const s = session({ provider, id: "gpt-5.5" });
    (s.state as { cwd: string }).cwd = dir;
    let renders = 0;
    let lookups = 0;
    const runtime = {
      config: {},
      host: undefined,
      providers: {
        findModel: () => {
          lookups++;
          return { ok: true, model: { compat: backend ? { chatgptBackend: backend } : {} } };
        },
      },
    } as unknown as Runtime;
    const a = new StatusArea({
      runtime,
      theme: plainTheme(),
      session: () => s,
      now: () => NOW,
      render: () => void renders++,
      layout: "full",
      env: { AMA_STATUS_GIT: "0" },
    });
    return { a, renders: () => renders, lookups: () => lookups };
  }

  it("codex 无数据 pending → quota_update 后显示；siwc 无数据与非订阅模型不显示", () => {
    const codex = area("codex");
    expect(codex.a.quotaView()).toBe("pending");
    expect(codex.a.onEvent(QUOTA as SessionEvent)).toBe(true);
    expect(codex.a.quotaView()).toEqual({ quota: QUOTA });
    expect(lines(codex.a.quota, 120)[0]).toContain("5 小时：10.0%");
    codex.a.quotaView();
    expect(codex.lookups()).toBe(1); // 按模型引用记住后端
    expect(area("siwc").a.quotaView()).toBeUndefined();
    const other = area(undefined, "anthropic");
    other.a.onEvent({ ...QUOTA, provider: "chatgpt" } as SessionEvent);
    expect(other.a.quotaView()).toBeUndefined();
    for (const x of [codex, other]) x.a.dispose();
  });

  it("有配额且 full 时每分钟重画一次；切到 compact 停表；dispose 停表", () => {
    const { a, renders } = area("codex");
    vi.advanceTimersByTime(5 * QUOTA_TICK_MS);
    expect(renders()).toBe(0); // pending 不挂计时器
    a.onEvent(QUOTA as SessionEvent);
    vi.advanceTimersByTime(QUOTA_TICK_MS - 1);
    expect(renders()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(renders()).toBe(1);
    vi.advanceTimersByTime(3 * QUOTA_TICK_MS);
    expect(renders()).toBe(4);
    a.setLayout("compact"); // 本身重画一次
    const after = renders();
    vi.advanceTimersByTime(5 * QUOTA_TICK_MS);
    expect(renders()).toBe(after);
    a.setLayout("full");
    a.dispose();
    const disposed = renders();
    vi.advanceTimersByTime(5 * QUOTA_TICK_MS);
    expect(renders()).toBe(disposed);
  });
});
