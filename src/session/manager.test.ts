import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import type { AssistantMessage, Message, SystemMessage } from "../ai/types.js";
import { SessionManager } from "./manager.js";
import { buildContext } from "./projection.js";
import { isSubagentSession, isSubagentSessionFile, sessionDirForCwd } from "./store.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const system: SystemMessage = {
  role: "system",
  sections: { preamble: "You are ama." },
  timestamp: 0,
};
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  stopReason: "stop",
  timestamp: 2,
});

function parentWithTurns(manager: SessionManager): string {
  manager.append({ type: "message", message: system });
  manager.append({ type: "message", message: user("one") });
  manager.append({ type: "message", message: assistant("a1") });
  manager.append({ type: "message", message: user("two") });
  return manager.append({ type: "message", message: assistant("a2") }).id;
}

describe("[ME-C0] SessionManager.fork(entryId, { head })", () => {
  it("head 成为根条目，复制的首条重挂到它下面；投影消息与父分支相同", () => {
    const parent = SessionManager.inMemory("/work");
    const last = parentWithTurns(parent);
    const forked = parent.fork(last, {
      head: {
        type: "custom",
        customType: "ama.task",
        data: { taskId: "t1", context: "fork", forkedFrom: last },
      },
    });
    const branch = forked.branch();
    const [head, first] = branch;
    expect(head?.type === "custom" && head.customType).toBe("ama.task");
    expect(head?.parentId).toBeNull();
    expect(first?.parentId).toBe(head?.id);
    expect(branch.slice(1).map((e) => e.id)).toEqual(parent.branch().map((e) => e.id));
    expect(branch.slice(2).map((e) => e.parentId)).toEqual(
      parent
        .branch()
        .slice(1)
        .map((e) => e.parentId),
    );
    expect(buildContext(branch).messages).toEqual(buildContext(parent.branch()).messages);
    expect(forked.leafId()).toBe(last);
    // 父分支的条目未被改动
    expect(parent.branch()[0]?.parentId).toBeNull();
  });

  it("落盘：新文件首条是 ama.task，按子 Agent 会话识别；不给 head 时照旧", () => {
    home = createTmpHome("ama-me-fork-");
    const dir = sessionDirForCwd(home.dataDir, home.cwd);
    const parent = SessionManager.create(dir, home.cwd);
    const last = parentWithTurns(parent);
    parent.flush();
    const forked = parent.fork(last, {
      head: { type: "custom", customType: "ama.task", data: { taskId: "t1", context: "fork" } },
    });
    const file = forked.file();
    expect(file).toBeDefined();
    expect(forked.header().parentSession).toBe(parent.file());
    expect(isSubagentSession(forked.header(), forked.entries()[0])).toBe(true);
    expect(isSubagentSessionFile(file ?? "")).toBe(true);
    const lines = readFileSync(file ?? "", "utf8")
      .trim()
      .split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      "session",
      "custom",
      "message",
      "message",
      "message",
      "message",
      "message",
    ]);
    forked.close();
    const reopened = SessionManager.open(file ?? "");
    expect(reopened.branch().map((e) => e.id)).toEqual(forked.branch().map((e) => e.id));
    reopened.close();
    const plain = parent.fork(last);
    expect(plain.branch()[0]?.type).toBe("message");
    expect(plain.branch()[0]?.parentId).toBeNull();
    plain.close();
    parent.close();
  });
});

describe("#183 SessionManager.setWarn", () => {
  it("open 的会话：setWarn 之前读不回的图片告警缓冲，接上后恰好 1 条", () => {
    home = createTmpHome();
    const dir = sessionDirForCwd(home.path("sessions"), "/work");
    const created = SessionManager.create(dir, "/work");
    const image = { type: "image" as const, mimeType: "image/png", data: "aW1n" };
    const id = created.append({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "x" }, image], timestamp: 1 },
    }).id;
    const before = created.leafId()!;
    created.append({
      type: "context_edit",
      targetId: id,
      replacement: "[image omitted]",
      reason: "image_budget",
    });
    created.flush();
    const file = created.file()!;
    created.close();
    const opened = SessionManager.open(file);
    expect(opened.offloadedCount()).toBe(1);
    writeFileSync(file, "{}\n".repeat(4), "utf8");
    opened.setLeaf(before);
    const warnings: string[] = [];
    opened.setWarn((message) => warnings.push(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(new RegExp(`^cannot read session entry ${id} back from `));
    opened.close();
  });
});
