import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { aggregateStats, isoWeek } from "../../session/stats-aggregate.js";
import { collectSummaries } from "../../session/stats-index.js";
import { summarizeSessionFile } from "../../session/stats-scan.js";
import {
  assistantEntry,
  toolResultEntry,
  usageOf,
  userEntry,
  writeFixtureSession,
} from "../../session/test-support.js";
import type { CliIo } from "../deps.js";
import { parseDaySpec, runStats } from "./stats.js";

let home: TmpHome;
let root: string;
let out: string[];
let err: string[];

const io = (cwd?: string): CliIo => ({
  stdout: (t) => void out.push(t),
  stderr: (t) => void err.push(t),
  stdinIsTTY: false,
  stdoutIsTTY: false,
  env: home.env,
  cwd: cwd ?? home.cwd,
  readStdin: async () => "",
});

beforeEach(() => {
  home = createTmpHome("ama-stats-");
  root = join(home.dataDir, "sessions");
  out = [];
  err = [];
});
afterEach(() => home.cleanup());

/** 本地时间的某天中午（避免跨日）。 */
const noon = (day: string): Date => new Date(`${day}T12:00:00`);

function sampleSession(): string {
  return writeFixtureSession(root, {
    id: "aaaa1111-0000-0000-0000-000000000001",
    cwd: home.cwd,
    start: noon("2026-09-30"),
    stepSeconds: 2,
    entries: [
      { type: "model_change", provider: "relay", modelId: "kimi", channel: "messages" },
      userEntry("修一下 bug"),
      assistantEntry("", usageOf(100, 10, 900, 0, 0.01), {
        provider: "relay",
        model: "kimi",
        tools: [{ name: "bash" }, { name: "read" }],
      }),
      toolResultEntry("bash", "ok"),
      toolResultEntry("read", "file"),
      assistantEntry("好了", usageOf(50, 20, 1000, 0, 0.02), { provider: "relay", model: "kimi" }),
      {
        type: "usage",
        kind: "cache_warm",
        provider: "relay",
        model: "kimi",
        usage: usageOf(1, 1, 1000, 0, 0.001),
      },
      userEntry("再看看", { origin: "followUp" }),
      userEntry("顺便", { origin: "steer" }),
      // 无价、不报缓存的端点
      assistantEntry("", usageOf(300, 30), {
        provider: "cheap",
        model: "m",
        tools: [{ name: "bash" }],
      }),
      { type: "context_edit", targetId: "e10", replacement: null, reason: "retry" },
      assistantEntry("err", usageOf(0, 0), { provider: "cheap", model: "m", stopReason: "error" }),
      {
        type: "usage",
        kind: "permission_classify",
        provider: "cheap",
        model: "m",
        usage: usageOf(40, 2),
      },
      {
        type: "compaction",
        summary: "s",
        firstKeptEntryId: "e2",
        tokensBefore: 10,
        usage: usageOf(500, 50),
      },
      { type: "custom", customType: "ama.todo", data: { items: [] } },
    ],
  });
}

describe("summarizeSessionFile", () => {
  it("按日期 / kind / 端点分桶，回合、工具、重试、错误都计入", () => {
    const summary = summarizeSessionFile(sampleSession())!;
    expect(summary.cwd).toBe(home.cwd);
    const turn = summary.buckets.find((b) => b.kind === "turn" && b.provider === "relay")!;
    expect(turn).toMatchObject({
      channel: "messages",
      requests: 2,
      input: 150,
      cacheRead: 1900,
      costed: 2,
      cacheSeen: true,
      turns: 1,
      timedTurns: 1,
      turnMs: 8000,
    });
    const cheap = summary.buckets.find((b) => b.kind === "turn" && b.provider === "cheap")!;
    expect(cheap).toMatchObject({ requests: 2, turns: 1, errors: 1, retries: 1, costed: 0 });
    expect(summary.buckets.map((b) => b.kind).sort()).toEqual([
      "cache_warm",
      "compaction",
      "permission_classify",
      "turn",
      "turn",
    ]);
    expect(summary.tools.map(([, name, n]) => `${name}:${n}`).sort()).toEqual(["bash:2", "read:1"]);
  });

  it("末尾半行忽略；中间坏行跳过计数；头不对返回 undefined", () => {
    const file = sampleSession();
    appendFileSync(file, '{"type":"message","message":{"role":"assis');
    expect(summarizeSessionFile(file)?.badLines).toBe(0);
    const bad = writeFixtureSession(root, {
      id: "bbbb",
      cwd: home.cwd,
      start: noon("2026-09-30"),
      entries: [userEntry("x")],
    });
    appendFileSync(bad, "not json\n" + JSON.stringify(assistantEntry("y", usageOf(1, 1))) + "\n");
    expect(summarizeSessionFile(bad)?.badLines).toBe(1);
    const noHeader = home.write("sessions-x/a_c.jsonl", '{"type":"message"}\n');
    expect(summarizeSessionFile(noHeader)).toBeUndefined();
  });
});

describe("aggregateStats", () => {
  it("命中率只算报告缓存的端点；费用只加有价请求；按 kind 分开计", () => {
    const report = aggregateStats([summarizeSessionFile(sampleSession())!]);
    const t = report.totals;
    expect(t.requests).toBe(7);
    expect(report.byKind).toEqual({
      turn: 4,
      cache_warm: 1,
      permission_classify: 1,
      compaction: 1,
    });
    // relay 报告缓存：读 2900 / (151 + 2900)；cheap 不进分母
    expect(t.hitRate).toBeCloseTo(2900 / (151 + 2900), 6);
    expect(t.cost).toBeCloseTo(0.031, 6);
    expect(t.unpriced).toBe(4);
    expect(t.turns).toBe(2);
    expect(report.endpoints).toEqual({ reported: 1, total: 2 });
    expect(report.tools).toEqual([
      { name: "bash", count: 2 },
      { name: "read", count: 1 },
    ]);
  });

  it("日期过滤与分组", () => {
    const a = summarizeSessionFile(sampleSession())!;
    const b = summarizeSessionFile(
      writeFixtureSession(root, {
        id: "cccc",
        cwd: "/other/proj",
        start: noon("2026-10-02"),
        entries: [userEntry("hi"), assistantEntry("yo", usageOf(10, 1, 0, 0, 0.5))],
      }),
    )!;
    expect(aggregateStats([a, b], { since: "2026-10-01" }).totals.requests).toBe(1);
    expect(aggregateStats([a, b], { until: "2026-09-30" }).sessions).toBe(1);
    const byDay = aggregateStats([a, b], { by: "day" }).groups!;
    expect(byDay.map((g) => g.key)).toEqual(["2026-09-30", "2026-10-02"]);
    const byProject = aggregateStats([a, b], { by: "project" }).groups!;
    expect(byProject.map((g) => g.key)).toEqual([home.cwd, "/other/proj"]);
    const byChannel = aggregateStats([a, b], { by: "channel" }).groups!.map((g) => g.key);
    expect(byChannel).toContain("relay/kimi@messages");
    expect(aggregateStats([a, b], { by: "month" }).groups!.map((g) => g.key)).toEqual([
      "2026-09",
      "2026-10",
    ]);
  });

  it("ISO 周", () => {
    expect(isoWeek("2026-10-02")).toBe("2026-W40");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(isoWeek("2024-12-30")).toBe("2025-W01");
  });
});

describe("parseDaySpec", () => {
  it("7d / today / 日期；非法报用法错误", () => {
    const now = new Date("2026-10-02T12:00:00");
    expect(parseDaySpec("since", "7d", now)).toBe("2026-09-26");
    expect(parseDaySpec("since", "1d", now)).toBe("2026-10-02");
    expect(parseDaySpec("since", "today", now)).toBe("2026-10-02");
    expect(parseDaySpec("since", "2026-01-05", now)).toBe("2026-01-05");
    expect(() => parseDaySpec("since", "last week", now)).toThrow(/since/);
    expect(() => parseDaySpec("since", "0d", now)).toThrow();
  });
});

describe("ama stats", () => {
  it("缺省只看当前目录；--all 看全部；--json 结构化；索引缓存写入数据目录", async () => {
    sampleSession();
    writeFixtureSession(root, {
      id: "dddd",
      cwd: "/other/proj",
      start: noon("2026-10-01"),
      entries: [userEntry("hi"), assistantEntry("yo", usageOf(10, 1))],
    });
    expect(await runStats([], io())).toBe(0);
    const text = out.join("");
    expect(text).toContain("1 个会话");
    expect(text).toContain("对话 4");
    expect(text).toContain("另有 4 次请求无价");
    expect(text).toMatch(/bash\s+2/);
    out = [];
    expect(await runStats(["--all", "--json", "--by", "project"], io())).toBe(0);
    const json = JSON.parse(out.join(""));
    expect(json.sessions).toBe(2);
    expect(json.groups).toHaveLength(2);
    // 当前目录那个会话在上一次运行时已进索引
    expect(json.files).toMatchObject({ total: 2, scanned: 1, cached: 1 });
    expect(existsSync(join(home.dataDir, "stats-index.json"))).toBe(true);
    out = [];
    await runStats(["--all", "--json"], io());
    expect(JSON.parse(out.join("")).files).toMatchObject({ scanned: 0, cached: 2 });
  });

  it("文件变化后重扫；--no-cache 不写索引", async () => {
    const file = sampleSession();
    await runStats(["--json"], io());
    const line = (id: string) =>
      JSON.stringify({
        ...assistantEntry(id, usageOf(1, 1)),
        id,
        parentId: null,
        timestamp: noon("2026-09-30").toISOString(),
      }) + "\n";
    appendFileSync(file, line("x1"));
    out = [];
    await runStats(["--json"], io());
    const json = JSON.parse(out.join(""));
    expect(json.files.scanned).toBe(1);
    expect(json.totals.requests).toBe(8);
    const indexBefore = readFileSync(join(home.dataDir, "stats-index.json"), "utf8");
    appendFileSync(file, line("y1"));
    await runStats(["--no-cache"], io());
    expect(readFileSync(join(home.dataDir, "stats-index.json"), "utf8")).toBe(indexBefore);
  });

  it("没有会话 / 参数错误", async () => {
    expect(await runStats([], io())).toBe(0);
    expect(out.join("")).toContain("没有模型请求");
    await expect(runStats(["--by", "hour"], io())).rejects.toThrow(/--by/);
    await expect(runStats(["--all", "--project", "."], io())).rejects.toThrow(/不能同时/);
  });

  it("collectSummaries 缓存无效文件，prune 删掉已不存在的条目", () => {
    const file = sampleSession();
    const index = join(home.dataDir, "stats-index.json");
    collectSummaries([file, join(root, "gone.jsonl")], { indexFile: index, prune: true });
    const data = JSON.parse(readFileSync(index, "utf8"));
    expect(Object.keys(data.files)).toEqual([file]);
  });
});

describe("与 SessionManager 写出的文件一致", () => {
  it("manager 落盘的会话：toolResult 行按前缀跳过，统计不丢", async () => {
    const { SessionManager } = await import("../../session/manager.js");
    const manager = SessionManager.create(join(root, "x"), home.cwd);
    manager.append(userEntry("hi") as never);
    manager.append(
      assistantEntry("", usageOf(10, 1, 5, 0, 0.1), { tools: [{ name: "grep" }] }) as never,
    );
    manager.append(toolResultEntry("grep", "found") as never);
    manager.append(assistantEntry("ok", usageOf(10, 1, 5)) as never);
    const file = manager.flush()!;
    manager.close();
    const summary = summarizeSessionFile(file)!;
    const report = aggregateStats([summary]);
    expect(report.totals).toMatchObject({ requests: 2, turns: 1, cacheRead: 10 });
    expect(report.tools).toEqual([{ name: "grep", count: 1 }]);
  });
});

describe("订阅计费（[W6-I5]）", () => {
  it("billing: subscription 的请求单列，不进费用、不算无价", async () => {
    const sub = { ...usageOf(100, 10, 50, 0, 0), billing: "subscription" as const };
    writeFixtureSession(root, {
      id: "eeee",
      cwd: home.cwd,
      start: noon("2026-10-02"),
      entries: [
        userEntry("hi"),
        assistantEntry("a", sub, { provider: "chatgpt", model: "gpt-5" }),
        assistantEntry("b", sub, { provider: "chatgpt", model: "gpt-5" }),
        assistantEntry("c", usageOf(10, 1, 0, 0, 0.5), { provider: "relay", model: "kimi" }),
      ],
    });
    expect(await runStats([], io())).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/订阅\s+2 次请求走 ChatGPT 套餐/);
    expect(text).toMatch(/费用\s+\$0\.5000\n/);
    out = [];
    await runStats(["--json"], io());
    expect(JSON.parse(out.join("")).totals).toMatchObject({
      requests: 3,
      subscription: 2,
      unpriced: 0,
      cost: 0.5,
    });
  });
});
