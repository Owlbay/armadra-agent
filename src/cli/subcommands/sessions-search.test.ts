import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { numberUserMessages, parseFromSpec, resolveFromMessage } from "../../session/reuse.js";
import { readSessionReadOnly } from "../../session/scan.js";
import { compileQuery, makeSnippet } from "../../session/search.js";
import {
  assistantEntry,
  toolResultEntry,
  usageOf,
  userEntry,
  writeFixtureSession,
} from "../../session/test-support.js";
import type { CliIo } from "../deps.js";
import { runSessionsSearch } from "./sessions-search.js";

let home: TmpHome;
let root: string;
let out: string[];

const io = (extra: Partial<CliIo> = {}): CliIo => ({
  stdout: (t) => void out.push(t),
  stderr: () => undefined,
  stdinIsTTY: false,
  stdoutIsTTY: false,
  env: home.env,
  cwd: home.cwd,
  readStdin: async () => "",
  ...extra,
});

const IMG = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

function fixtures(): { a: string; b: string } {
  const a = writeFixtureSession(root, {
    id: "aaaaaaaa-1111",
    cwd: home.cwd,
    start: new Date("2026-09-30T08:00:00Z"),
    entries: [
      userEntry("请修复 Parser 的 bug"),
      assistantEntry("先看看 parser.ts", usageOf(1, 1), {
        tools: [{ name: "grep", arguments: { pattern: "parseExpr" } }],
      }),
      toolResultEntry("grep", "src/parser.ts:10: function parseExpr("),
      { type: "leaf", id: "e2", timestamp: "2026-09-30T08:00:09Z" },
      userEntry([{ type: "text", text: "看这张图" }, IMG], { origin: "followUp" }),
      assistantEntry("图里是 parser 报错", usageOf(1, 1)),
    ],
  });
  const b = writeFixtureSession(root, {
    id: "bbbbbbbb-2222",
    cwd: "/elsewhere",
    start: new Date("2026-10-01T08:00:00Z"),
    entries: [userEntry('写个 "quoted" PARSER'), assistantEntry("ok", usageOf(1, 1))],
  });
  return { a, b };
}

beforeEach(() => {
  home = createTmpHome("ama-search-");
  root = join(home.dataDir, "sessions");
  out = [];
});
afterEach(() => home.cleanup());

describe("compileQuery / makeSnippet", () => {
  it("关键词不区分大小写；正则带标志；含引号的关键词不做原始行预筛", () => {
    expect(compileQuery("PARSER").match("a parser b Parser")).toEqual([
      [2, 8],
      [11, 17],
    ]);
    expect(compileQuery("/pars(e|er)\\b/i").match("Parse it")).toEqual([[0, 5]]);
    expect(compileQuery('"quoted"').mayContain('{"x":"\\"quoted\\""}')).toBe(true);
    expect(compileQuery("abc").mayContain('{"x":"zzz"}')).toBe(false);
    expect(() => compileQuery("/(/")).toThrow();
  });

  it("片段压平空白并换算命中区间", () => {
    const text = `${"x".repeat(80)}\n\n  hello   world`;
    const ranges = compileQuery("world").match(text);
    const s = makeSnippet(text, ranges, 10);
    expect(s.snippet.startsWith("…")).toBe(true);
    const [range] = s.ranges;
    expect(s.snippet.slice(range![0], range![1])).toBe("world");
  });
});

describe("ama sessions search", () => {
  it("缺省只搜当前目录；--all 全部；user 命中给 #编号、其它给 @条目序号", async () => {
    fixtures();
    expect(await runSessionsSearch(["parser"], io())).toBe(0);
    const text = out.join("");
    expect(text).toContain("aaaaaaaa#1");
    expect(text).toContain("aaaaaaaa@2");
    expect(text).toContain("aaaaaaaa@3");
    // leaf 行不算条目：followUp 是第 4 条条目、第 2 条用户消息（不含 parser 字样）
    expect(text).toContain("aaaaaaaa@5");
    expect(text).not.toContain("bbbbbbbb");
    expect(text).not.toContain("\x1b[");
    out = [];
    await runSessionsSearch(["parser", "--all", "--role", "user"], io());
    expect(out.join("")).toContain("bbbbbbbb#1");
    expect(out.join("")).not.toContain("@");
  });

  it("TTY 高亮；--json 每行一条；--limit 截断；--since 过滤", async () => {
    fixtures();
    await runSessionsSearch(["Parser", "--all"], io({ stdoutIsTTY: true }));
    expect(out.join("")).toContain("\x1b[1;33m");
    out = [];
    await runSessionsSearch(["parser", "--all", "--json", "--limit", "2"], io());
    const lines = out.join("").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ sessionId: "bbbbbbbb-2222", userN: 1 });
    out = [];
    await runSessionsSearch(["parser", "--all", "--since", "2026-10-01", "--json"], io());
    expect(out.join("").trim().split("\n")).toHaveLength(1);
    out = [];
    await runSessionsSearch(["parser", "--all", "--limit", "1"], io());
    expect(out.join("")).toContain("--limit 1");
  });

  it("没有命中 / 参数错误", async () => {
    fixtures();
    await runSessionsSearch(["nothing-here"], io());
    expect(out.join("")).toContain("没有命中");
    await expect(runSessionsSearch([], io())).rejects.toThrow(/关键词/);
    await expect(runSessionsSearch(["/(/"], io())).rejects.toThrow(/正则/);
    await expect(runSessionsSearch(["x", "--role", "system"], io())).rejects.toThrow(/--role/);
  });
});

describe("用户消息编号与 --from", () => {
  it("按文件顺序编号，带 origin 与图片", () => {
    const { a } = fixtures();
    const users = numberUserMessages(readSessionReadOnly(a).entries);
    expect(users.map((u) => [u.n, u.text, u.origin, u.images.length])).toEqual([
      [1, "请修复 Parser 的 bug", undefined, 0],
      [2, "看这张图", "followUp", 1],
    ]);
  });

  it("<id>#n 取第 n 条，<id> 取最后一条；前缀可用；越界与格式错误", () => {
    fixtures();
    expect(resolveFromMessage(root, "aaaaaaaa#1", home.cwd).text).toBe("请修复 Parser 的 bug");
    const last = resolveFromMessage(root, "aaaa");
    expect(last).toMatchObject({ n: 2, text: "看这张图", sessionId: "aaaaaaaa-1111" });
    expect(last.images).toHaveLength(1);
    expect(() => resolveFromMessage(root, "aaaaaaaa#9")).toThrow(/只有 2 条/);
    expect(() => resolveFromMessage(root, "zzzz")).toThrow(/不存在/);
    expect(() => parseFromSpec("abc#x")).toThrow(/--from/);
    expect(parseFromSpec("abc#3")).toEqual({ id: "abc", n: 3 });
  });
});

describe("ama sessions show 列出用户消息编号", () => {
  it("编号、origin 与图片数", async () => {
    fixtures();
    const { createSessionStore } = await import("../compose-store.js");
    const { runSessions } = await import("./sessions.js");
    expect(await runSessions(["show", "aaaaaaaa"], io(), { sessions: createSessionStore() })).toBe(
      0,
    );
    const text = out.join("");
    expect(text).toContain("ama --from aaaaaaaa#<编号>");
    expect(text).toMatch(/#1 +2026-09-30 08:00:01 +请修复 Parser 的 bug/);
    expect(text).toMatch(/#2 .*\[followUp\] \[图片 1\] 看这张图/);
  });
});
