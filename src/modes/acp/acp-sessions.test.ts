import { describe, expect, it } from "vitest";
import type { AcpPromptResult } from "../../drivers/acp/types.js";
import type { SessionListItem } from "../../session/types.js";
import {
  PromptQueue,
  TITLE_LIMIT,
  cleanTitle,
  decodeCursor,
  encodeCursor,
  pageSessions,
  sessionTitle,
  type PromptJob,
} from "./acp-sessions.js";

describe("标题清洗", () => {
  it("去掉嵌入资源块（含被截断没有结尾的），取第一个非空行，压空白，≤ 80 字", () => {
    expect(cleanTitle('<resource uri="file:///a">\nx\n</resource>\n  fix   it\nmore')).toBe(
      "fix it",
    );
    expect(cleanTitle('look\n<resource uri="file:///a">\nconst a')).toBe("look");
    expect(cleanTitle('<resource uri="file:///a">\nconst a')).toBeNull();
    expect(cleanTitle("   \n\n")).toBeNull();
    expect(cleanTitle(undefined)).toBeNull();
    const long = cleanTitle("x".repeat(200))!;
    expect(long).toHaveLength(TITLE_LIMIT);
    expect(long.endsWith("…")).toBe(true);
  });

  it("会话名优先，否则首条用户提示", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello\nworld" }],
        timestamp: 0,
      },
    ];
    expect(sessionTitle("named", messages)).toBe("named");
    expect(sessionTitle(undefined, messages)).toBe("hello");
    expect(sessionTitle(undefined, [])).toBeNull();
  });
});

describe("session/list 分页", () => {
  const item = (id: string, modifiedAt: string): SessionListItem => ({
    id,
    file: `/s/${id}.jsonl`,
    cwd: "/w",
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 1,
    firstPrompt: `prompt ${id}`,
  });
  const items = [
    item("a", "2026-10-01T00:00:00.000Z"),
    item("b", "2026-10-03T00:00:00.000Z"),
    item("c", "2026-10-02T00:00:00.000Z"),
    item("d", "2026-10-02T00:00:00.000Z"),
    item("e", "2026-10-04T00:00:00.000Z"),
  ];

  it("updatedAt 降序（同时刻按 id），cursor 逐页走完不重不漏", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = pageSessions(items, cursor, 2);
      seen.push(...result.sessions.map((s) => s.sessionId));
      if (result.nextCursor === undefined || result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(["e", "b", "d", "c", "a"]);
    expect(pageSessions(items, undefined).nextCursor).toBeUndefined();
    expect(pageSessions(items, undefined).sessions[0]).toEqual({
      sessionId: "e",
      cwd: "/w",
      title: "prompt e",
      updatedAt: "2026-10-04T00:00:00.000Z",
    });
  });

  it("cursor 指向已删除的会话也能续上；非法 cursor → invalid params", () => {
    const cursor = encodeCursor("2026-10-02T12:00:00.000Z", "zz");
    expect(pageSessions(items, cursor).sessions.map((s) => s.sessionId)).toEqual(["d", "c", "a"]);
    expect(decodeCursor(encodeCursor("t", "id|x"))).toEqual({ updatedAt: "t", sessionId: "id|x" });
    for (const bad of ["bogus", "", 42, Buffer.from("nobar").toString("base64")])
      expect(() => pageSessions(items, bad)).toThrow(expect.objectContaining({ code: -32602 }));
  });
});

describe("PromptQueue", () => {
  function job(sessionId: string, log: string[]): PromptJob & { result: Promise<AcpPromptResult> } {
    let resolve!: (r: AcpPromptResult) => void;
    let reject!: (e: unknown) => void;
    const result = new Promise<AcpPromptResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void result.then(
      (r) => log.push(`${sessionId}:${r.stopReason}`),
      () => log.push(`${sessionId}:error`),
    );
    return {
      sessionId,
      text: sessionId,
      images: [],
      cancelRequested: false,
      resolve,
      reject,
      result,
    };
  }

  it("FIFO 一次一个；排队中的可取消（直接 cancelled）；run 抛错交回该提示", async () => {
    const log: string[] = [];
    const started: string[] = [];
    const queue = new PromptQueue(async (j) => {
      started.push(j.sessionId);
      await new Promise((r) => setTimeout(r, 10));
      if (j.sessionId === "c") throw new Error("boom");
      return { stopReason: "end_turn" };
    });
    const a = job("a", log);
    const b = job("b", log);
    const c = job("c", log);
    const b2 = job("b", log);
    for (const j of [a, b, c, b2]) queue.push(j);
    expect(queue.running).toBe(a);
    expect(queue.size).toBe(3);
    expect(queue.cancelQueued("b")).toBe(2);
    await expect(b.result).resolves.toMatchObject({ stopReason: "cancelled" });
    await expect(c.result).rejects.toThrow("boom");
    await queue.settled();
    expect(started).toEqual(["a", "c"]);
    expect(log).toEqual(["b:cancelled", "b:cancelled", "a:end_turn", "c:error"]);
    expect(queue.running).toBeUndefined();
  });

  it("settled(id) 只等属于该会话的在跑提示", async () => {
    let release!: () => void;
    const queue = new PromptQueue(
      () => new Promise((r) => (release = () => r({ stopReason: "end_turn" }))),
    );
    queue.push(job("a", []));
    await queue.settled("other");
    expect(queue.running?.sessionId).toBe("a");
    const waiting = queue.settled("a");
    release();
    await waiting;
    expect(queue.running).toBeUndefined();
  });
});
