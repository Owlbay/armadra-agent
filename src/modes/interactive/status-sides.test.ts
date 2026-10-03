/**
 * full 布局左右分区（[W7]）：左 = 状态 / 开关（权限模式、shift+tab 提示、codemode、沙箱、预设、回退），
 * 右 = 度量与模型（tps、用量、模型、Ctx、git、费用、时长、配额）。帧黄金覆盖 zh + en × 120 / 80 / 60 / 40 列 ×
 * 「Bypass + codemode on + 订阅配额」/「非订阅、无配额」，外加 NO_COLOR、ASCII 与 compact 记号顺序不变。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, SessionStats } from "../../agent/types.js";
import type { QuotaUpdateEvent } from "../../agent/types-w6.js";
import type { StatusLineMode } from "../../config/types.js";
import { setLocale } from "../../i18n/index.js";
import { createTheme, plainTheme, stripAnsi, visibleWidth, type Theme } from "../../tui.js";
import { StatusBar, type StatusBarSource } from "./status-bar.js";
import { StatusLine } from "./status-line.js";
import { QuotaLine, type QuotaView } from "./status-quota.js";
import { golden } from "./test-support.js";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const HOUR = 3_600_000;

/** 用户截图的会话：codex 登录、Bypass、codemode on、刚回完一条。 */
const STATS = {
  sessionId: "s",
  sessionFile: undefined,
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  tokens: { input: 1_200, output: 185, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
  contextTokens: 1_300,
  contextWindow: 272_000,
  contextPercent: 0.5,
  telemetry: {
    sessionStartedAt: 0,
    avgTps: 18,
    last: {
      requestAt: 0,
      firstTokenAt: 6_300,
      ttftMs: 6_300,
      doneAt: 16_700,
      outputTokens: 185,
      tps: 18,
    },
  },
} as SessionStats;

const QUOTA: QuotaUpdateEvent = {
  type: "quota_update",
  provider: "chatgpt",
  primary: { usedPercent: 12, windowMinutes: 300, resetsAt: NOW + 2 * HOUR + 18 * 60_000 },
  secondary: { usedPercent: 31, windowMinutes: 10_080, resetsAt: NOW + 163 * HOUR },
};

interface Scenario {
  subscription: boolean;
  layout?: StatusLineMode;
  theme?: Theme;
  extra?: Partial<StatusBarSource>;
}

function rows(width: number, s: Scenario): string[] {
  const theme = s.theme ?? plainTheme();
  const layout = s.layout ?? "full";
  const model = s.subscription
    ? { provider: "chatgpt", id: "gpt-6-astra", channel: "codex" }
    : { provider: "anthropic", id: "claude-opus-5-5" };
  const session = {
    state: { model, thinkingLevel: "medium", permissionMode: "full-auto", cwd: "/w" },
    getStats: () => STATS,
  } as unknown as AgentSession;
  const quota: QuotaView = s.subscription ? { quota: QUOTA } : undefined;
  const source: StatusBarSource = {
    session: () => session,
    preset: () => "default",
    layout: () => layout,
    codemode: () => "on",
    git: () => ({ dir: "yovinchen", info: undefined }),
    now: () => NOW,
    sessionStartedAt: () => NOW - 60_000,
    quota: () => quota,
    ...s.extra,
  };
  const bar = new StatusBar(source, theme);
  const line = new QuotaLine({ layout: () => layout, quota: () => quota, now: () => NOW }, theme);
  return [
    ...new StatusLine(bar, source, theme).render(width),
    ...bar.render(width),
    ...line.render(width),
  ];
}

const framed = (list: string[], width: number): string[] =>
  list.map((l) => `|${stripAnsi(l)}${" ".repeat(Math.max(0, width - visibleWidth(l)))}|`);

afterEach(() => setLocale("zh"));

describe("[W7] full 左右分区", () => {
  for (const locale of ["zh", "en"] as const) {
    it(`${locale} 帧黄金：120 / 80 / 60 / 40 列 × 订阅配额 / 非订阅；开关齐全；ASCII`, () => {
      setLocale(locale);
      const out: string[] = [];
      for (const subscription of [true, false]) {
        for (const width of [120, 80, 60, 40]) {
          const list = rows(width, { subscription });
          for (const l of list) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
          out.push(`# ${width} ${subscription ? "订阅配额" : "非订阅"}`, ...framed(list, width));
        }
      }
      const busy: Scenario = {
        subscription: true,
        extra: {
          preset: () => "minimal",
          bashSandbox: () => true,
          sandboxStrict: () => false,
          fallback: () => ({ from: "chatgpt/gpt-6-astra@codex", to: "anthropic/claude-sonnet-5" }),
        },
      };
      for (const width of [120, 80, 40]) {
        out.push(
          `# ${width} 开关齐全（预设、沙箱、net!、回退）`,
          ...framed(rows(width, busy), width),
        );
      }
      const ascii = plainTheme({ ascii: true });
      out.push("# 80 ASCII", ...framed(rows(80, { ...busy, theme: ascii }), 80));
      golden(`${locale === "en" ? "en/" : ""}status-sides`, out.join("\n") + "\n");
    });
  }

  it("左列：权限模式与 codemode 在左、度量在右；权限模式永不丢，窄屏时开关比度量后丢", () => {
    setLocale("en");
    const [rate, bar, quota] = rows(120, { subscription: true }).map(stripAnsi);
    expect(rate).toMatch(/^codemode on {4,}tps: 18 tok\/s • 185 tok \/ 10\.4s .* · \[-\]$/);
    expect(bar).toMatch(
      /^Bypass permissions \| shift\+tab to cycle {4,}chatgpt\/gpt-6-astra@codex /,
    );
    expect(quota).toMatch(/^ {4,}Session: 12\.0% \| Reset: 2h 18m \| Weekly: 31\.0% \|/);
    for (const width of [40, 30, 20]) {
      const [r, b] = rows(width, { subscription: true }).map(stripAnsi);
      expect(b).toMatch(/^Bypass permissions/);
      if (width >= 40) expect(r).toMatch(/^codemode on {4,}tps: 18 tok\/s · \[-\]$/);
    }
  });

  it("NO_COLOR：结构与纯文本一致、没有颜色转义", () => {
    const noColor = createTheme("dark", { caps: { colors: 0 }, ascii: false });
    for (const width of [120, 60]) {
      const out = rows(width, { subscription: true, theme: noColor });
      for (const l of out) expect(l).not.toContain("\x1b[3");
      expect(out.map(stripAnsi)).toEqual(rows(width, { subscription: true }).map(stripAnsi));
    }
  });

  it("compact：记号顺序不变（单行，开关仍在右区既有位置，配额短项在行尾）", () => {
    const [line] = rows(240, { subscription: true, layout: "compact" }).map(stripAnsi);
    expect(line).toMatch(
      /^Bypass permissions · shift\+tab 切换 {4,}chatgpt\/gpt-6-astra@codex · medium · ↑1\.2k ↓185 · ctx ▮*▯+ 1% · yovinchen · 1m · codemode on · 5h 12% 周 31%$/,
    );
    expect(rows(240, { subscription: true, layout: "compact" })).toHaveLength(1);
  });
});
