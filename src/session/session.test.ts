import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { SessionManager } from "./manager.js";
import { migrateSessionLines } from "./migrate.js";
import { buildContext, buildProjection, replaySystem } from "./projection.js";
import {
  acquireLock,
  encodeCwd,
  purgeTrash,
  readSessionLines,
  sessionDirForCwd,
  sessionFileName,
  sessionIdFromFileName,
  trashSession,
} from "./store.js";
import { commonAncestor, entriesBetween, indexEntries } from "./tree.js";
import type { AssistantMessage, Message } from "../ai/types.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function tmp(): TmpHome {
  home = createTmpHome("ama-b2-session-");
  return home;
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  stopReason: "stop",
  timestamp: 2,
  ...extra,
});

describe("store", () => {
  it("编码 cwd、文件名与 id 互逆", () => {
    expect(encodeCwd("/Users/a/proj")).toBe("Users-a-proj");
    expect(encodeCwd("C:\\work\\x")).toBe("C--work-x");
    const name = sessionFileName(new Date("2026-10-02T05:23:11.123Z"), "abc-1");
    expect(name).toBe("2026-10-02T05-23-11-123Z_abc-1.jsonl");
    expect(sessionIdFromFileName(`/x/${name}`)).toBe("abc-1");
    expect(sessionDirForCwd("/root", "/a/b")).toBe(join("/root", "a-b"));
  });

  it("末尾半行被截掉，中间损坏行拒绝", () => {
    const h = tmp();
    const file = h.write(
      "s.jsonl",
      `{"type":"session","version":1,"id":"x","cwd":"/","timestamp":"t","agent":{"name":"ama","version":"0"}}\n{"id":"a","type":"label"`,
    );
    const read = readSessionLines(file, { repair: true });
    expect(read.repairedTail).toBe(true);
    expect(read.lines).toHaveLength(1);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    const bad = h.write("bad.jsonl", `{"type":"session"}\nnot json\n{}\n`);
    expect(() => readSessionLines(bad)).toThrow(/invalid JSON/);
  });

  it("锁：同一文件第二次加锁失败，释放后可再加；陈旧锁被接管", () => {
    const h = tmp();
    const file = h.write("l.jsonl", "");
    const lock = acquireLock(file);
    expect(() => acquireLock(file)).toThrow(/in use/);
    lock.release();
    writeFileSync(`${file}.lock`, "999999999");
    const again = acquireLock(file);
    again.release();
  });

  it("trash：移入后 7 天内保留，过期清理", () => {
    const h = tmp();
    const root = h.path("sessions");
    const file = h.write("sessions/proj/a.jsonl", "{}\n");
    const now = Date.now();
    const trashed = trashSession(file, root, now);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(trashed)).toBe(true);
    expect(purgeTrash(root, now + 6 * 86_400_000)).toEqual([]);
    expect(purgeTrash(root, now + 8 * 86_400_000)).toEqual([trashed]);
  });
});

describe("migrate", () => {
  it("只接受 version 1 的头", () => {
    expect(() => migrateSessionLines([])).toThrow(/missing session header/);
    expect(() =>
      migrateSessionLines([{ type: "session", version: 2, id: "x", cwd: "/" } as never]),
    ).toThrow(/version 2/);
  });
});

describe("SessionManager", () => {
  it("延迟落盘：flush 前没有文件，flush 后逐条追加，重开得到同一棵树", () => {
    const h = tmp();
    const dir = sessionDirForCwd(h.dataDir, h.cwd);
    const manager = SessionManager.create(dir, h.cwd);
    manager.append({ type: "message", message: user("hi") });
    expect(manager.file()).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    const file = manager.flush();
    expect(file).toBeDefined();
    const a = manager.append({ type: "message", message: assistant("hello") });
    expect(a.parentId).toBe(manager.entries()[0]?.id);
    const lines = readFileSync(file as string, "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string).type).toBe("session");
    manager.close();

    const reopened = SessionManager.open(file as string);
    expect(reopened.id).toBe(manager.id);
    expect(reopened.leafId()).toBe(a.id);
    expect(reopened.branch().map((e) => e.id)).toEqual(manager.branch().map((e) => e.id));
    reopened.close();
    expect(SessionManager.list(dir)[0]?.firstPrompt).toBe("hi");
  });

  it("open 修复崩溃留下的半行后可继续追加", () => {
    const h = tmp();
    const dir = sessionDirForCwd(h.dataDir, h.cwd);
    const manager = SessionManager.create(dir, h.cwd);
    manager.append({ type: "message", message: user("one") });
    const file = manager.flush() as string;
    manager.close();
    appendFileSync(file, `{"type":"message","id":"zz","parentId":null`);
    const reopened = SessionManager.open(file);
    reopened.append({ type: "message", message: user("two") });
    reopened.close();
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["session", "message", "message"]);
  });

  it("setLeaf 分叉、getEntries 游标、fork 复制分支到新文件", () => {
    const h = tmp();
    const dir = sessionDirForCwd(h.dataDir, h.cwd);
    const m = SessionManager.create(dir, h.cwd);
    const u1 = m.append({ type: "message", message: user("1") });
    const a1 = m.append({ type: "message", message: assistant("a1") });
    m.setLeaf(u1.id);
    const a2 = m.append({ type: "message", message: assistant("a2") });
    expect(m.branch().map((e) => e.id)).toEqual([u1.id, a2.id]);
    expect(m.getTree()[0]?.children.map((n) => n.entry.id)).toEqual([a1.id, a2.id]);
    expect(m.getEntries(a1.id).entries.map((e) => e.id)).toEqual([a2.id]);
    const index = indexEntries(m.entries());
    expect(commonAncestor(index, a1.id, a2.id)).toBe(u1.id);
    expect(entriesBetween(index, u1.id, a1.id).map((e) => e.id)).toEqual([a1.id]);
    m.flush();
    const forked = m.fork(a1.id);
    expect(forked.file()).toBeDefined();
    expect(forked.header().parentSession).toBe(m.file());
    expect(forked.branch().map((e) => e.id)).toEqual([u1.id, a1.id]);
    expect(readdirSync(dir).filter((n) => n.endsWith(".jsonl"))).toHaveLength(2);
    forked.close();
    m.close();
  });

  it("名字取最新 session_info；内存会话从不落盘", () => {
    const m = SessionManager.inMemory("/tmp/x");
    m.setName("a");
    m.setName("b");
    expect(m.name()).toBe("b");
    expect(m.flush()).toBeUndefined();
    expect(m.file()).toBeUndefined();
  });
});

describe("projection", () => {
  it("context_edit：最新一条赢，null 剔除，字符串换内容", () => {
    const m = SessionManager.inMemory("/w");
    const u = m.append({ type: "message", message: user("q") });
    const a = m.append({ type: "message", message: assistant("long answer") });
    m.append({ type: "context_edit", targetId: a.id, replacement: "short", reason: "prune" });
    let messages = buildProjection(m.branch()).messages;
    expect(messages).toHaveLength(2);
    expect((messages[1] as AssistantMessage).content).toEqual([{ type: "text", text: "short" }]);
    m.append({ type: "context_edit", targetId: a.id, replacement: null, reason: "retry" });
    messages = buildProjection(m.branch()).messages;
    expect(messages.map((x) => x.role)).toEqual(["user"]);
    expect(u.id).toBeDefined();
  });

  it("compaction：摘要在前、firstKept 之后保留、之前的 system 折成检查点", () => {
    const m = SessionManager.inMemory("/w");
    m.append({
      type: "message",
      message: {
        role: "system",
        sections: { preamble: "P", cwd: "C" },
        toolsAdded: [{ name: "read", description: "r", parameters: {} }],
        timestamp: 0,
      },
    });
    m.append({ type: "message", message: user("old") });
    m.append({ type: "message", message: assistant("old answer") });
    const kept = m.append({ type: "message", message: user("kept") });
    m.append({
      type: "message",
      message: { role: "system", sections: { cwd: "C2" }, toolsRemoved: ["read"], timestamp: 0 },
    });
    m.append({ type: "message", message: assistant("kept answer") });
    m.append({ type: "compaction", summary: "S", firstKeptEntryId: kept.id, tokensBefore: 999 });
    m.append({ type: "message", message: user("after") });
    m.append({ type: "model_change", provider: "p", modelId: "m" });
    const { messages, model } = buildContext(m.branch());
    expect(messages.map((x) => x.role)).toEqual([
      "system",
      "compactionSummary",
      "user",
      "assistant",
      "user",
    ]);
    const state = replaySystem(messages);
    expect(state).toEqual({ sections: { preamble: "P", cwd: "C2" }, tools: [] });
    expect(model).toEqual({ provider: "p", id: "m" });
  });
});
