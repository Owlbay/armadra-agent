/**
 * 打断并立即发送（`prompt / steer` 的 `interrupt: true`）：中止当前回合（模型流 / 工具按 abort 收尾），
 * 立刻以「排队的 steer… + 本条」开新回合；缓存前缀不变。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../tools/bash.js";
import type { SessionEvent } from "./types.js";
import { createHarness, toolResultCounts, userTexts, type Harness } from "./testing/harness.js";
import { stubPermission, stubTool } from "./testing/stubs.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ama-interrupt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function until(h: Harness, match: (event: SessionEvent) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (h.events.some(match)) return resolve();
    const off = h.session.subscribe((event) => {
      if (!match(event)) return;
      off();
      resolve();
    });
  });
}

const streaming = (event: SessionEvent): boolean =>
  event.type === "message_update" && event.message.role === "assistant";

describe("打断并立即发送", () => {
  it("模型长回复中途：旧回合 aborted 收尾，新回合收到「排队 steer + 本条」，origin interrupt，前缀不变", async () => {
    const h = createHarness({
      dir,
      script: [{ kind: "hang", text: "a very long reply that never ends" }, { text: "ok" }],
    });
    const first = h.session.prompt("go");
    await until(h, streaming);
    expect(await h.session.steer("queued A")).toBe("queued");
    expect(await h.session.steer("now B", { interrupt: true })).toBe("handled");
    expect(await first).toBe("started");

    expect(h.scripted.calls).toHaveLength(2);
    const [before, after] = h.scripted.calls as [
      (typeof h.scripted.calls)[0],
      (typeof h.scripted.calls)[0],
    ];
    expect(userTexts(after.context).at(-1)).toBe("queued A\n\nnow B");
    // 缓存：新请求以上一请求的全部消息为前缀（被中断的 assistant 按 abort 落盘规则接在后面）
    expect(after.context.messages.slice(0, before.context.messages.length)).toEqual(
      before.context.messages,
    );
    const users = h.session.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.origin)).toEqual([undefined, "interrupt"]);
    const aborted = h.session.messages.find(
      (m) => m.role === "assistant" && m.stopReason === "aborted",
    );
    expect(aborted).toBeDefined();
    expect(h.session.getLastAssistantText()).toBe("ok");
    expect(h.session.state.pendingMessageCount).toBe(0);
    // 落盘：两条 user 都在文件里，新回合的在被中断的 assistant 之后
    const roles = h
      .fileEntries()
      .flatMap((e) => (e.type === "message" ? [e.message.role] : []))
      .filter((r) => r !== "system");
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("长时间 bash 被打断：每个 tool_call 恰有一个结果（aborted by user），新回合立即开始", async () => {
    const bash = createBashTool();
    const h = createHarness({
      dir,
      cwd: dir,
      tools: [bash],
      permission: stubPermission(),
      script: [{ toolCalls: [{ name: "bash", args: { command: "sleep 30" } }] }, { text: "fine" }],
    });
    const started = Date.now();
    const first = h.session.prompt("run it");
    await until(h, (e) => e.type === "tool_execution_start");
    await h.session.prompt("stop, do this instead", { interrupt: true });
    await first;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(h.scripted.calls).toHaveLength(2);
    expect(userTexts(h.scripted.calls[1]!.context).at(-1)).toBe("stop, do this instead");
    const counts = toolResultCounts(h.fileEntries());
    expect([...counts.values()]).toEqual([1]);
    const result = h.session.messages.find((m) => m.role === "toolResult");
    expect(result?.role === "toolResult" && result.isError).toBe(true);
    expect(h.session.getLastAssistantText()).toBe("fine");
  });

  it("工具执行中打断：未开始的调用直接给中断结果，配对完整", async () => {
    const slow = stubTool({
      name: "slow",
      run: (_input, ctx) =>
        new Promise((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve({ content: "stopped" }), {
            once: true,
          }),
        ),
    });
    const h = createHarness({
      tools: [slow],
      script: [
        {
          toolCalls: [
            { name: "slow", args: {} },
            { name: "slow", args: {} },
          ],
        },
        { text: "next" },
      ],
    });
    const first = h.session.prompt("go");
    await until(h, (e) => e.type === "tool_execution_start");
    await h.session.steer("change of plan", { interrupt: true });
    await first;
    const calls = h.session.messages.flatMap((m) =>
      m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => b.id) : [],
    );
    const results = h.session.messages.flatMap((m) =>
      m.role === "toolResult" ? [m.toolCallId] : [],
    );
    expect(results.sort()).toEqual(calls.sort());
    expect(userTexts(h.scripted.calls[1]!.context).at(-1)).toBe("change of plan");
  });

  it("followUp 留在队列：新回合结束后照常投递", async () => {
    const h = createHarness({
      script: [{ kind: "hang", text: "busy" }, { text: "interrupt handled" }, { text: "later" }],
    });
    const first = h.session.prompt("go");
    await until(h, streaming);
    await h.session.followUp("after all that");
    await h.session.steer("right now", { interrupt: true });
    await first;
    expect(h.scripted.calls).toHaveLength(3);
    expect(userTexts(h.scripted.calls[1]!.context).at(-1)).toBe("right now");
    expect(userTexts(h.scripted.calls[2]!.context).at(-1)).toBe("after all that");
  });

  it("没有可发的内容：invalid_arguments，不中断当前回合", async () => {
    const h = createHarness({ script: [{ kind: "hang", text: "busy" }] });
    const first = h.session.prompt("go");
    await until(h, streaming);
    await expect(h.session.steer("  ", { interrupt: true })).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    expect(h.session.state.isStreaming).toBe(true);
    await h.session.abort();
    await first;
  });

  it("空闲时等同普通提示（不写 origin）", async () => {
    const h = createHarness({ script: [{ text: "hi" }] });
    expect(await h.session.steer("hello", { interrupt: true })).toBe("handled");
    expect(h.session.messages.find((m) => m.role === "user")?.origin).toBeUndefined();
    expect(await h.session.prompt("again", { interrupt: true })).toBe("started");
    expect(h.session.messages.filter((m) => m.role === "user").at(-1)?.origin).toBeUndefined();
  });

  it("显式 origin 优先（宿主注入）", async () => {
    const h = createHarness({ script: [{ kind: "hang" }, { text: "ok" }] });
    const first = h.session.prompt("go");
    await until(h, (e) => e.type === "message_start" && e.message.role === "assistant");
    await h.session.prompt("from host", { interrupt: true, origin: "host" });
    await first;
    expect(h.session.messages.filter((m) => m.role === "user").at(-1)?.origin).toBe("host");
  });
});
