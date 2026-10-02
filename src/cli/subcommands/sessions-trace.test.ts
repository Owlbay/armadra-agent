/**
 * `ama sessions trace`（docs/wave6-plan.md §2.5）：id / 路径定位、HTML 到 stdout 与文件、`--json` 同 get_trace 形状、
 * `--no-content`、`--children`、`--open` 只测命令构造（不真开浏览器）、参数错误。[W6-T2]
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import {
  assistantEntry,
  usageOf,
  userEntry,
  writeFixtureSession,
} from "../../session/test-support.js";
import { UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { runSessions } from "./sessions.js";
import { openCommand, runSessionsTrace, type OpenCommand } from "./sessions-trace.js";

const FIXTURES = join(process.cwd(), "test", "fixtures", "trace");
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

let home: TmpHome;
let out: string[];
let err: string[];

const io = (): CliIo => ({
  stdout: (t) => void out.push(t),
  stderr: (t) => void err.push(t),
  stdinIsTTY: false,
  stdoutIsTTY: false,
  env: home.env,
  cwd: home.cwd,
  readStdin: async () => "",
});

beforeEach(() => {
  home = createTmpHome("ama-trace-");
  out = [];
  err = [];
});
afterEach(() => home.cleanup());

/** subagent 夹具复制到临时目录，子会话路径改成临时目录里的真实文件。 */
function subagentCopy(): string {
  const dir = join(home.root, "sessions-copy");
  mkdirSync(dir, { recursive: true });
  const child = join(dir, "subagent-child.jsonl");
  writeFileSync(child, readFileSync(join(FIXTURES, "subagent-child.jsonl")));
  const parent = join(dir, "subagent.jsonl");
  const escaped = JSON.stringify(child).slice(1, -1);
  writeFileSync(
    parent,
    readFileSync(join(FIXTURES, "subagent.jsonl"), "utf8")
      .split("/data/sessions/--work-proj--/subagent-child.jsonl")
      .join(escaped),
  );
  return parent;
}

describe("ama sessions trace", () => {
  it("按 id 前缀找会话；缺省 HTML 到 stdout；--now 定生成时间", async () => {
    writeFixtureSession(join(home.dataDir, "sessions"), {
      id: "tttttttt-0001",
      cwd: home.cwd,
      start: new Date("2026-10-01T08:00:00Z"),
      entries: [userEntry("hello trace"), assistantEntry("hi", usageOf(10, 5))],
    });
    expect(await runSessionsTrace(["tttttttt", "--now", String(NOW)], io())).toBe(0);
    const html = out.join("");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("2026-10-03T12:00:00.000Z");
    expect(html).toContain("hello trace");
    // 同输入同输出
    out = [];
    await runSessionsTrace(["tttttttt", "--now", String(NOW)], io());
    expect(out.join("")).toBe(html);
  });

  it("--html <文件>：写文件（0600），stderr 提示；--html= 形式也认", async () => {
    const target = join(home.root, "t.html");
    expect(await runSessionsTrace([join(FIXTURES, "basic.jsonl"), "--html", target], io())).toBe(0);
    expect(out).toEqual([]);
    expect(readFileSync(target, "utf8")).toContain("<!doctype html>");
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(err.join("")).toContain(target);
    const second = join(home.root, "u.htm");
    await runSessionsTrace([`--html=${second}`, join(FIXTURES, "basic.jsonl")], io());
    expect(readFileSync(second, "utf8")).toContain("<!doctype html>");
  });

  it("--json：与 get_trace 同形（全部回合、已加载子会话、previews）；--no-content 不带预览与正文", async () => {
    const file = subagentCopy();
    expect(await runSessions(["trace", file, "--json"], io(), undefined)).toBe(0);
    const json = JSON.parse(out.join("")) as Record<string, unknown> & {
      trace: { turns: unknown[] };
      previews?: Record<string, unknown>;
    };
    expect(Object.keys(json).sort()).toEqual(
      ["cursor", "hasMoreBefore", "leafId", "previews", "trace"].sort(),
    );
    expect(json["hasMoreBefore"]).toBe(false);
    expect(JSON.stringify(json.trace)).toContain('"sessionId":"sess-child"');
    expect(json.previews?.["turn:su004"]).toBeDefined();
    out = [];
    await runSessionsTrace([file, "--format", "json", "--no-content"], io());
    const bare = out.join("");
    expect(JSON.parse(bare)).not.toHaveProperty("previews");
    expect(bare).not.toContain("测试覆盖，另起");
  });

  it("--children：HTML 内嵌子会话预览；缺省只嵌结构", async () => {
    const file = subagentCopy();
    await runSessionsTrace([file, "--now", "0"], io());
    const plain = out.join("");
    out = [];
    await runSessionsTrace([file, "--now", "0", "--children"], io());
    const withKids = out.join("");
    // 子会话第一条提示的预览只在 --children 时出现在详情里
    expect(plain).toContain('"pc":1');
    expect(withKids).not.toContain('"pc":1');
    expect(withKids.length).toBeGreaterThan(plain.length);
  });

  it("--open：写到临时文件后按平台构造打开命令（不真开）", async () => {
    const calls: OpenCommand[] = [];
    const code = await runSessionsTrace([join(FIXTURES, "basic.jsonl"), "--open"], io(), {
      open: async (c) => void calls.push(c),
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("xdg-open");
    const path = calls[0]?.args[0] as string;
    expect(path).toMatch(/ama-trace-sess-basic\.html$/);
    expect(readFileSync(path, "utf8")).toContain("<!doctype html>");
    expect(openCommand("darwin", "/x.html")).toEqual({ command: "open", args: ["/x.html"] });
    expect(openCommand("win32", "C:\\x.html")).toEqual({
      command: "explorer",
      args: ["C:\\x.html"],
    });
    const failing = await runSessionsTrace([join(FIXTURES, "basic.jsonl"), "--open"], io(), {
      open: async () => {
        throw new Error("no browser");
      },
    });
    expect(failing).not.toBe(0);
    expect(err.join("")).toContain("no browser");
    rmSync(path, { force: true });
  });

  it("参数错误：缺 id、--html 与 --json 同用、--branch / --format / --now 非法", async () => {
    const basic = join(FIXTURES, "basic.jsonl");
    for (const argv of [
      [],
      [basic, "--html", "--json"],
      [basic, "--branch", "x"],
      [basic, "--format", "md"],
      [basic, "--now", "soon"],
      [basic, "extra"],
    ])
      await expect(runSessionsTrace(argv, io())).rejects.toBeInstanceOf(UsageError);
    expect(await runSessionsTrace(["--help"], io())).toBe(0);
    expect(out.join("")).toContain("ama sessions trace");
  });
});
