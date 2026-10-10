import { describe, expect, it, vi } from "vitest";
import type { AcpPromptResult } from "../../drivers/acp/types.js";
import type { SessionListItem } from "../../session/types.js";
import {
  PromptQueue,
  TITLE_LIMIT,
  cleanTitle,
  decodeCursor,
  encodeCursor,
  pageSessions,
  promptWhenIdle,
  quiesce,
  sessionTitle,
  type PromptJob,
} from "./acp-sessions.js";
import type { AgentSessionImpl } from "../../agent/session.js";
import type { TaskControl } from "../../agents/task-control.js";
import { AmaError } from "../../errors.js";

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

describe("promptWhenIdle [M-A]（#139）", () => {
  /** 只模拟 promptWhenIdle 用到的面：周期（waitForIdle）与 prompt 的 busy 规则。 */
  function fakeSession() {
    let cycle: { promise: Promise<void>; end: () => void } | undefined;
    const startCycle = () => {
      let end!: () => void;
      const promise = new Promise<void>((resolve) => (end = resolve));
      cycle = {
        promise,
        end: () => {
          cycle = undefined;
          end();
        },
      };
      return cycle;
    };
    const prompt = vi.fn(async (_text: string, _options?: unknown) => {
      if (cycle !== undefined) throw new AmaError("busy", "a run is in progress");
    });
    const session = {
      prompt,
      waitForIdle: () => cycle?.promise ?? Promise.resolve(),
    } as unknown as AgentSessionImpl;
    return { session, prompt, startCycle };
  }
  const job = (extra: Partial<PromptJob> = {}): PromptJob => ({
    sessionId: "s",
    text: "hi",
    images: [],
    cancelRequested: false,
    resolve: () => undefined,
    reject: () => undefined,
    ...extra,
  });

  it("空闲：直接发；带图时传 images", async () => {
    const f = fakeSession();
    await promptWhenIdle(f.session, job());
    const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
    await promptWhenIdle(f.session, job({ images: [image] }));
    expect(f.prompt.mock.calls).toEqual([
      ["hi", {}],
      ["hi", { images: [image] }],
    ]);
  });

  it("通知回合在跑：等它结束再发，不报 busy", async () => {
    const f = fakeSession();
    const notification = f.startCycle();
    const done = promptWhenIdle(f.session, job());
    await new Promise((r) => setTimeout(r, 10));
    expect(f.prompt).not.toHaveBeenCalled();
    notification.end();
    await done;
    expect(f.prompt).toHaveBeenCalledTimes(1);
  });

  it("与通知器竞速输了（空闲后它先开了回合）：busy 后再等一轮；onStart 每次发起前都调（#166）", async () => {
    const f = fakeSession();
    const onStart = vi.fn();
    let raced: { end: () => void } | undefined;
    f.prompt.mockImplementationOnce(async () => {
      raced = f.startCycle();
      throw new AmaError("busy", "a run is in progress");
    });
    const done = promptWhenIdle(f.session, job(), onStart);
    await new Promise((r) => setTimeout(r, 10));
    expect(f.prompt).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    raced!.end();
    await done;
    expect(f.prompt).toHaveBeenCalledTimes(2);
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("等待中被取消：不再发；其它错误原样抛出", async () => {
    const f = fakeSession();
    const notification = f.startCycle();
    const j = job();
    const onStart = vi.fn();
    const done = promptWhenIdle(f.session, j, onStart);
    j.cancelRequested = true;
    notification.end();
    await done;
    expect(f.prompt).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    f.prompt.mockRejectedValueOnce(new AmaError("session_closed", "session is disposed"));
    await expect(promptWhenIdle(f.session, job())).rejects.toMatchObject({
      code: "session_closed",
    });
  });
});

describe("quiesce（#167）", () => {
  /** 周期 + abort；`restarts` 次 abort 后由「通知器」在周期结算后的微任务里再开一轮。 */
  function busySession(running: boolean, restarts: number) {
    let cycle: Promise<void> | undefined;
    let end: (() => void) | undefined;
    const start = (): void => {
      cycle = new Promise<void>((resolve) => {
        end = () => {
          cycle = undefined;
          resolve();
        };
      });
    };
    if (running) start();
    const abort = vi.fn(async () => {
      const current = cycle;
      if (current === undefined) return;
      end!();
      await current;
      if (restarts-- > 0) queueMicrotask(start);
    });
    const session = {
      abort,
      waitForIdle: () => cycle ?? Promise.resolve(),
    } as unknown as AgentSessionImpl;
    return { session, abort, busy: () => cycle !== undefined };
  }

  it("已空闲：一轮即返回 true；先停在跑的后台任务（结束的不动）", async () => {
    const f = busySession(false, 0);
    const stop = vi.fn(async () => undefined);
    const control = {
      list: () => [
        { taskId: "a", status: "running" },
        { taskId: "b", status: "completed" },
      ],
      stop,
    } as unknown as TaskControl;
    await expect(quiesce(f.session, control)).resolves.toBe(true);
    expect(stop.mock.calls).toEqual([["a"]]);
    expect(f.abort).toHaveBeenCalledTimes(1);
  });

  it("在跑 / 结算后又开了一轮：反复 abort 直到隔一个宏任务仍空闲", async () => {
    const once = busySession(true, 0);
    await expect(quiesce(once.session, undefined)).resolves.toBe(true);
    expect(once.abort).toHaveBeenCalledTimes(1);
    const twice = busySession(true, 2);
    await expect(quiesce(twice.session, undefined)).resolves.toBe(true);
    expect(twice.abort).toHaveBeenCalledTimes(3);
    expect(twice.busy()).toBe(false);
  });

  it("超过 rounds 仍不空闲：返回 false", async () => {
    const f = busySession(true, Infinity);
    await expect(quiesce(f.session, undefined, 3)).resolves.toBe(false);
    expect(f.abort).toHaveBeenCalledTimes(3);
  });
});
