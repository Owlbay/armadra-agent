import { describe, expect, it } from "vitest";
import type { AgentSession, EnqueueOptions, PromptOptions } from "../agent/types.js";
import { defaultSendUser } from "./startup-steps.js";

function fakeSession(isStreaming: boolean): {
  session: AgentSession;
  calls: { method: "steer" | "prompt"; text: string; options: unknown }[];
} {
  const calls: { method: "steer" | "prompt"; text: string; options: unknown }[] = [];
  const session = {
    state: { isStreaming },
    async steer(text: string, options?: EnqueueOptions) {
      calls.push({ method: "steer", text, options });
    },
    async prompt(text: string, options?: PromptOptions) {
      calls.push({ method: "prompt", text, options });
      return "started" as const;
    },
  };
  return { session: session as unknown as AgentSession, calls };
}

describe("defaultSendUser：宿主 sendUser 的缺省实现", () => {
  it("运行中：steer 入队并带上 origin", async () => {
    const { session, calls } = fakeSession(true);
    expect(await defaultSendUser(session, "hi", "armadra")).toBe("queued");
    expect(calls).toEqual([{ method: "steer", text: "hi", options: { origin: "armadra" } }]);
  });

  it("空闲：prompt 立即开始，streamingBehavior 为 steer 并带上 origin", async () => {
    const { session, calls } = fakeSession(false);
    expect(await defaultSendUser(session, "hi", "host")).toBe("started");
    expect(calls).toEqual([
      { method: "prompt", text: "hi", options: { streamingBehavior: "steer", origin: "host" } },
    ]);
  });

  it("未给 origin 时不写 origin 键", async () => {
    const { session, calls } = fakeSession(true);
    await defaultSendUser(session, "hi");
    expect(calls[0]?.options).toEqual({});
  });
});
