/**
 * [W5-H2] 周期收尾阶段入队的 steer / followUp 不滞留（W5-G 发现的竞态，修复在 session-run.ts 的 runCycle）：
 * 宿主 `sendUser`（会话仍算忙 → 入队）与子 Agent 后台通知（`followUp{origin:"task"}`）两种来源。
 */

import { describe, expect, it } from "vitest";
import { defaultSendUser } from "../cli/startup-steps.js";
import { createHarness, userTexts } from "./testing/harness.js";
import { stubHooks, stubTool } from "./testing/stubs.js";

describe("周期收尾阶段入队的消息（W5-H2）", () => {
  it("宿主 sendUser 在 onAgentSettled 里调用：同一周期再开一轮投递，不等下一次用户提示", async () => {
    let sent = false;
    const h = createHarness({
      script: [{ text: "first" }, { text: "second" }],
      extensions: [
        ({ core }) => ({
          id: "late-host",
          onAgentSettled: async () => {
            if (sent) return;
            sent = true;
            // 此时 agent 已不在运行（isStreaming false），但会话周期未结束：prompt 只能入队
            expect(await defaultSendUser(core as never, "from host", "host")).toBe("started");
          },
        }),
      ],
    });
    await h.session.prompt("go");
    expect(h.scripted.calls).toHaveLength(2);
    expect(userTexts(h.scripted.calls[1]!.context)).toEqual(["go", "from host"]);
    expect(h.session.state.pendingMessageCount).toBe(0);
    expect(h.types().filter((t) => t === "agent_settled")).toHaveLength(2);
  });

  it("子 Agent 后台通知（followUp origin task）在 agent_settled 监听器里入队：照样投递", async () => {
    const h = createHarness({ script: [{ text: "first" }, { text: "noted" }] });
    let notified = false;
    h.session.subscribe((event) => {
      if (event.type !== "agent_settled" || notified) return;
      notified = true;
      void h.session.followUp("<task-notification>done</task-notification>", { origin: "task" });
    });
    await h.session.prompt("go");
    await h.session.waitForIdle();
    expect(h.scripted.calls).toHaveLength(2);
    const delivered = h.session.messages.find((m) => m.role === "user" && m.origin === "task");
    expect(delivered).toBeDefined();
    expect(h.session.getLastAssistantText()).toBe("noted");
  });

  it("Stop Hook 期间入队的 followUp：本轮直接续投（不先 settle）", async () => {
    let h!: ReturnType<typeof createHarness>;
    h = createHarness({
      script: [{ text: "first" }, { text: "second" }],
      hooks: stubHooks({
        Stop: () => {
          if (h.scripted.calls.length === 1) void h.session.followUp("queued during stop hook");
          return undefined;
        },
      }),
    });
    await h.session.prompt("go");
    expect(h.scripted.calls).toHaveLength(2);
    expect(h.types().filter((t) => t === "agent_settled")).toHaveLength(1);
  });

  it("已请求停止（预算 / Hook continue:false）或 abort：不续投，消息留在队列", async () => {
    const ls = stubTool({ name: "ls" });
    const h = createHarness({
      script: [{ toolCalls: [{ name: "ls", args: {} }] }, { text: "never" }],
      tools: [ls],
      extensions: [
        ({ core }) => ({
          id: "stopper",
          onEvent: (event) => {
            if (event.type === "message_end" && event.message.role === "assistant")
              core.requestStop(undefined);
          },
          onAgentSettled: () => void h.session.followUp("later"),
        }),
      ],
    });
    await h.session.prompt("go");
    expect(h.scripted.calls).toHaveLength(1);
    expect(h.session.state.pendingMessageCount).toBe(1);
  });
});
