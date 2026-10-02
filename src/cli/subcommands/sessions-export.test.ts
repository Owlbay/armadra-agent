import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { REDACTED, redactSecrets, redactValue } from "../../session/redact.js";
import { migrateSessionLines } from "../../session/migrate.js";
import {
  assistantEntry,
  toolResultEntry,
  usageOf,
  userEntry,
  writeFixtureSession,
} from "../../session/test-support.js";
import type { SessionLine } from "../../session/types.js";
import type { CliIo } from "../deps.js";
import { runSessionsExport } from "./sessions-export.js";

let home: TmpHome;
let root: string;
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

const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX";

/** 两个分支：e1 → e2 → e3（被 leaf 行放弃）与 e1 → e2 → e5 → e6（当前）。 */
function fixture(): string {
  return writeFixtureSession(root, {
    id: "eeeeeeee-0001",
    cwd: home.cwd,
    start: new Date("2026-10-01T08:00:00Z"),
    entries: [
      userEntry(`配置里是 ANTHROPIC_API_KEY=${KEY}`),
      assistantEntry("我来看看", usageOf(100, 10, 50, 0, 0.01), {
        tools: [{ name: "bash", arguments: { command: "cat .env", apiKey: "plainsecret123" } }],
      }),
      toolResultEntry("bash", `token: ghp_${"a".repeat(36)}\n${"y".repeat(3000)}`),
      { type: "leaf", id: "e2", timestamp: "2026-10-01T08:00:04Z" },
      {
        ...userEntry([
          { type: "text", text: "换个方向" },
          { type: "image", data: "sk-AAAAAAAAAAAAAAAAAAAA", mimeType: "image/png" },
        ]),
        parentId: "e2",
      },
      assistantEntry("好的", usageOf(10, 5), { provider: "other", model: "m" }),
      { type: "session_info", name: "导出测试" },
    ],
  });
}

beforeEach(() => {
  home = createTmpHome("ama-export-");
  root = join(home.dataDir, "sessions");
  out = [];
  err = [];
});
afterEach(() => home.cleanup());

describe("redact", () => {
  it("常见 key 形态、Bearer、键值对、私钥块", () => {
    const text = [
      `key ${KEY}`,
      "openai sk-proj-abcdefghijklmnop1234",
      "Authorization: Bearer abc.def.ghijklmnopqrstu",
      'api_key = "hunter2hunter2"',
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      "maxTokens: 8192 普通文本 sk-short",
    ].join("\n");
    const red = redactSecrets(text);
    expect(red).not.toContain("api03");
    expect(red).not.toContain("sk-proj");
    expect(red).toContain(`Authorization: Bearer ${REDACTED}`);
    expect(red).toContain(`api_key = "${REDACTED}`);
    expect(red).not.toContain("AKIA");
    expect(red).not.toContain("MIIE");
    expect(red).toContain("maxTokens: 8192 普通文本 sk-short");
  });

  it("对象：键名像机密的整段遮掉，图片 data 保留", () => {
    const value = redactValue({
      apiKey: "plainsecret123",
      nested: [{ text: `x ${KEY}` }],
      image: { type: "image", data: "sk-AAAAAAAAAAAAAAAAAAAA", mimeType: "image/png" },
      totalTokens: 5,
    });
    expect(value).toEqual({
      apiKey: REDACTED,
      nested: [{ text: `x ${REDACTED}` }],
      image: { type: "image", data: "sk-AAAAAAAAAAAAAAAAAAAA", mimeType: "image/png" },
      totalTokens: 5,
    });
  });
});

describe("ama sessions export", () => {
  it("md：当前分支、编号、工具调用与截断的结果、用量；已脱敏", async () => {
    fixture();
    expect(await runSessionsExport(["eeeeeeee"], io())).toBe(0);
    const md = out.join("");
    expect(md).toContain("# 导出测试");
    expect(md).toContain("范围：当前分支（5 条条目）");
    expect(md).toContain("## 用户 #1");
    expect(md).toContain("## 用户 #2");
    expect(md).toContain("[图片 image/png]");
    expect(md).toContain("**工具调用** `bash`");
    expect(md).not.toContain("**结果**"); // e3 不在当前分支
    expect(md).not.toContain(KEY);
    expect(md).not.toContain("plainsecret123");
    expect(md).toContain("| 2 | 110 | 15 | 50 | 0 | $0.0100 |");
  });

  it("--branch all 含被放弃的分支，结果截断；--format json 结构化", async () => {
    fixture();
    await runSessionsExport(["eeeeeeee", "--branch", "all"], io());
    const md = out.join("");
    expect(md).toContain("**结果** `bash`");
    expect(md).toContain("（截断，原长");
    expect(md).not.toContain("ghp_");
    out = [];
    await runSessionsExport(["eeeeeeee", "--format", "json"], io());
    const doc = JSON.parse(out.join(""));
    expect(doc).toMatchObject({
      format: "ama.session-export",
      version: 1,
      session: { id: "eeeeeeee-0001", name: "导出测试" },
      branch: "leaf",
      leafId: "e7",
      userMessages: [
        { n: 1, entryId: "e1" },
        { n: 2, entryId: "e5" },
      ],
      usage: { requests: 2, input: 110 },
    });
    expect(doc.entries.map((e: { id: string }) => e.id)).toEqual(["e1", "e2", "e5", "e6", "e7"]);
    expect(JSON.stringify(doc)).not.toContain(KEY);
    expect(doc.entries[2].message.content[1].data).toBe("sk-AAAAAAAAAAAAAAAAAAAA");
  });

  it("jsonl 可以再被读回；--output 写文件 0600", async () => {
    fixture();
    const target = join(home.root, "out.jsonl");
    await runSessionsExport(["eeeeeeee", "--format", "jsonl", "--output", target], io());
    expect(out).toEqual([]);
    expect(err.join("")).toContain(target);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    const lines = readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SessionLine);
    const migrated = migrateSessionLines(lines);
    expect(migrated.entries.map((e) => e.id)).toEqual(["e1", "e2", "e5", "e6", "e7"]);
  });

  it("参数错误与不存在的会话", async () => {
    fixture();
    await expect(runSessionsExport([], io())).rejects.toThrow(/<id>/);
    await expect(runSessionsExport(["eeee", "--format", "html"], io())).rejects.toThrow(/--format/);
    await expect(runSessionsExport(["eeee", "--branch", "x"], io())).rejects.toThrow(/--branch/);
    await expect(runSessionsExport(["nope"], io())).rejects.toThrow(/不存在/);
  });
});
