/**
 * 会话扩展点（docs/history/wave5-plan.md §10.1）：调用点、顺序、异常隔离、每个会话实例各自的扩展。[W5-C0]
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SessionManager } from "../session/manager.js";
import type { AgentMessage } from "../session/types.js";
import type { SessionExtension, SessionExtensionFactory } from "./session-extensions.js";
import { AgentSessionImpl } from "./session.js";
import { createHarness, userTexts } from "./testing/harness.js";
import { fakeModel, stubRegistry, stubTool } from "./testing/stubs.js";

function note(id: string, content: string): AgentMessage {
  return { role: "custom", customType: id, content, display: false, timestamp: 0 };
}

describe("SessionExtension 调用点", () => {
  it("beforePrompts 按表顺序追加在 prompts 之后并落盘，后者能看到前者的追加", async () => {
    const seen: number[] = [];
    const a: SessionExtensionFactory = () => ({
      id: "a",
      beforePrompts: () => [note("ext.a", "first")],
    });
    const b: SessionExtensionFactory = () => ({
      id: "b",
      beforePrompts: (_ctx, prompts) => {
        seen.push(prompts.length);
        return [note("ext.b", "second")];
      },
    });
    const h = createHarness({ script: [{ text: "ok" }], extensions: [a, b] });
    await h.session.prompt("hi");
    expect(seen).toEqual([2]);
    const customs = h.manager
      .branch()
      .flatMap((entry) => (entry.type === "custom_message" ? [entry.customType] : []));
    expect(customs).toEqual(["ext.a", "ext.b"]);
    // 追加在用户消息之后（尾部）
    const kinds = h.manager
      .branch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user"
          ? ["user"]
          : entry.type === "custom_message"
            ? [entry.customType]
            : [],
      );
    expect(kinds).toEqual(["user", "ext.a", "ext.b"]);
  });

  it("wrapStream 包在缓存控制器之内，onEvent 收到全部事件，onAgentSettled 在周期结束前", async () => {
    const order: string[] = [];
    let wrappedCalls = 0;
    let settledBeforeIdle = false;
    const factory: SessionExtensionFactory = () => ({
      id: "probe",
      wrapStream: (inner) => (model, context, options) => {
        wrappedCalls++;
        return inner(model, context, options);
      },
      onEvent: (event) => {
        if (event.type === "agent_settled") order.push("event:agent_settled");
      },
      onAgentSettled: async () => {
        order.push("settled");
        settledBeforeIdle = true;
      },
    });
    const h = createHarness({ script: [{ text: "ok" }], extensions: [factory] });
    await h.session.prompt("hi");
    await h.session.waitForIdle();
    expect(wrappedCalls).toBe(1);
    expect(order).toEqual(["event:agent_settled", "settled"]);
    expect(settledBeforeIdle).toBe(true);
  });

  it("contributeStats 补字段；dispose 调用；钩子抛错只记日志", async () => {
    const logs: string[] = [];
    let disposed = 0;
    const broken: SessionExtension = {
      id: "broken",
      beforePrompts: () => {
        throw new Error("boom");
      },
      onEvent: () => {
        throw new Error("boom");
      },
    };
    const h = createHarness({
      script: [{ text: "ok" }],
      log: (_level, message) => logs.push(message),
      extensions: [
        () => broken,
        () => ({
          id: "stats",
          contributeStats: (stats) => {
            stats.tasks = { total: 1, running: 0, byStatus: { completed: 1 } };
          },
          dispose: () => disposed++,
        }),
      ],
    });
    await h.session.prompt("hi");
    expect(h.session.getStats().tasks).toEqual({
      total: 1,
      running: 0,
      byStatus: { completed: 1 },
    });
    expect(logs.some((line) => line.includes("extension broken failed in beforePrompts"))).toBe(
      true,
    );
    expect(h.types()).toContain("agent_settled");
    await h.session.dispose();
    expect(disposed).toBe(1);
  });

  it("工厂对每个会话实例各调一次；按 depth 决定子会话是否装配", async () => {
    const depths: number[] = [];
    const factory: SessionExtensionFactory = ({ core }) => {
      depths.push(core.depth);
      return core.depth > 0 ? undefined : { id: "root-only" };
    };
    const task = stubTool({
      name: "task",
      permission: "execute",
      run: async (_input, ctx) => {
        const sub = await ctx.spawnSubagent!({
          prompt: "sub job",
          parentToolCallId: ctx.toolCallId,
          signal: ctx.signal,
        });
        return { content: sub.text, isError: sub.isError };
      },
    });
    const h = createHarness({
      tools: [task],
      extensions: [factory],
      script: (call) =>
        userTexts(call.context)[0] === "sub job"
          ? { text: "child" }
          : call.context.messages.at(-1)?.role === "toolResult"
            ? { text: "done" }
            : { toolCalls: [{ name: "task", args: {} }] },
    });
    await h.session.prompt("go");
    expect(depths).toEqual([0, 1]);
  });

  it("没有扩展时行为不变（无额外条目）", async () => {
    const h = createHarness({ script: [{ text: "ok" }] });
    await h.session.prompt("hi");
    expect(h.manager.branch().some((entry) => entry.type === "custom_message")).toBe(false);
  });
});

describe("#183 manager 告警接到会话日志", () => {
  const root = mkdtempSync(join(tmpdir(), "ama-ext-warn-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let seq = 0;
  type Logged = [string, string];
  const READ_BACK = /^cannot read session entry \S+ back from /;

  /** 落盘：含图消息被 context_edit 改写（已卸载）；返回编辑之前的叶子。 */
  function withOffloadedImage(manager: SessionManager): string {
    const id = manager.append({
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "image", mimeType: "image/png", data: "aW1n" },
        ],
        timestamp: 1,
      },
    }).id;
    const before = manager.leafId()!;
    manager.append({
      type: "context_edit",
      targetId: id,
      replacement: "[image omitted]",
      reason: "image_budget",
    });
    manager.flush();
    return before;
  }

  it("会话构造后：文件被外部改写，getEntries 回读失败 → options.log(warn) 恰好 1 次；运行时换掉的 log 也生效", () => {
    const logged: Logged[] = [];
    const h = createHarness({ script: [], dir: join(root, `h${seq++}`), log: () => undefined });
    withOffloadedImage(h.manager);
    expect(h.manager.offloadedCount()).toBe(1);
    // TUI 的 routeNotices 在运行时替换 options.log
    (h.session as unknown as { options: { log: (l: string, m: string) => void } }).options.log = (
      level,
      message,
    ) => logged.push([level, message]);
    writeFileSync(h.manager.file()!, "{}\n".repeat(4), "utf8");
    h.manager.getEntries();
    h.manager.getEntries();
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toBe("warn");
    expect(logged[0]![1]).toMatch(READ_BACK);
  });

  it("resume / 子会话续聊：会话构造前（open 之后）的告警在构造时冲出，恰好 1 次", () => {
    const dir = join(root, `r${seq++}`);
    const created = SessionManager.create(dir, "/work");
    const before = withOffloadedImage(created);
    const file = created.file()!;
    created.close();
    const opened = SessionManager.open(file);
    writeFileSync(file, "{}\n".repeat(4), "utf8");
    opened.setLeaf(before);
    const logged: Logged[] = [];
    const model = fakeModel();
    const session = new AgentSessionImpl({
      model,
      sessionManager: opened,
      providers: stubRegistry([model], []),
      depth: 1,
      log: (level, message) => logged.push([level, message]),
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toBe("warn");
    expect(logged[0]![1]).toMatch(READ_BACK);
    void session.dispose();
  });
});
