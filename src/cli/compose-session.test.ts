import { afterEach, describe, expect, it } from "vitest";
import {
  composeHarness,
  recordingHost,
  type ComposeHarness,
} from "../../test/helpers/compose-harness.js";
import type { HostApi } from "../host/types.js";
import type { ApprovalRequest } from "../permissions/types.js";
import { currentSession, switchSession } from "./compose-session.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

const bashCall = (command: string) => ({
  steps: [{ toolCall: { name: "bash", arguments: { command } } }],
});

function toolResults(messages: readonly { role: string }[]) {
  return messages.filter((m) => m.role === "toolResult") as { isError?: boolean }[];
}

function hostApi(): HostApi {
  return (globalThis as Record<string, unknown>)["__amaHostEventsApi"] as HostApi;
}

describe("composeSession：审批链", () => {
  it("宿主 setBroker 在会话创建之后调用也生效", async () => {
    h = composeHarness([bashCall("echo hi"), { text: "done" }]);
    const host = recordingHost(h.home);
    const runtime = await h.boot(["--model", "fake/echo", "--host", host.path]);
    const asked: ApprovalRequest[] = [];
    hostApi().approvals.setBroker({ ask: async (r) => (asked.push(r), "allow") });
    await runtime.session.prompt("go");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.toolName).toBe("bash");
    expect(toolResults(runtime.session.messages)[0]?.isError).not.toBe(true);
    const names = host.events().map((e) => e.name);
    expect(names).toContain("tool_approval_requested");
    expect(names).toContain("tool_approval_resolved");
    expect(names).toContain("tool_call");
    await runtime.dispose();
  });

  it("宿主弃权后走 setUiBroker 设置的 UI；撤下后无人作答 → deny", async () => {
    h = composeHarness([bashCall("echo a"), { text: "1" }, bashCall("echo b"), { text: "2" }]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    const seen: string[] = [];
    runtime.approvals.setUiBroker({ ask: async (r) => (seen.push(r.toolName), "deny") });
    await runtime.session.prompt("first");
    expect(seen).toEqual(["bash"]);
    expect(toolResults(runtime.session.messages)[0]?.isError).toBe(true);
    runtime.approvals.setUiBroker(undefined);
    await runtime.session.prompt("second");
    expect(seen).toHaveLength(1);
    expect(toolResults(runtime.session.messages)[1]?.isError).toBe(true);
    await runtime.dispose();
  });
});

describe("switchSession", () => {
  it("new：旧会话 dispose，HostApi.session.id() 与 currentSession 跟随新会话", async () => {
    h = composeHarness();
    const host = recordingHost(h.home);
    const runtime = await h.boot(["--model", "fake/echo", "--host", host.path]);
    await runtime.session.prompt("one");
    const firstId = hostApi().session.id();
    const next = await switchSession(runtime, { kind: "new" });
    expect(currentSession(runtime)).toBe(next);
    expect(hostApi().session.id()).toBe(next.state.sessionId);
    expect(next.state.sessionId).not.toBe(firstId);
    await expect(runtime.session.prompt("x")).rejects.toMatchObject({ code: "session_closed" });
    await next.prompt("two");
    expect(next.getLastAssistantText()).toBe("two");
    const starts = host.events().filter((e) => e.name === "session_start");
    expect(starts.map((e) => (e.event as { reason: string }).reason)).toEqual(["startup", "new"]);
    await runtime.dispose();
  });

  it("resume / fork 回到已落盘的会话", async () => {
    h = composeHarness();
    const runtime = await h.boot(["--model", "fake/echo"]);
    await runtime.session.prompt("keep me");
    const file = runtime.session.state.sessionFile as string;
    const id = runtime.session.state.sessionId;
    const fresh = await switchSession(runtime, { kind: "new" });
    expect(fresh.messages).toHaveLength(0);
    const resumed = await switchSession(runtime, { kind: "resume", id: id.slice(0, 8) });
    expect(resumed.state.sessionFile).toBe(file);
    expect(resumed.getLastAssistantText()).toBe("keep me");
    const leaf = resumed.entries.at(-1)?.id as string;
    const forked = await switchSession(runtime, { kind: "fork", entryId: leaf });
    expect(forked.state.sessionFile).not.toBe(file);
    expect(forked.getLastAssistantText()).toBe("keep me");
    await runtime.dispose();
  });
});

describe("启动期预检", () => {
  it("模型的协议没有实现 → 退出 4，提示协议名", async () => {
    h = composeHarness();
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      providers: {
        future: {
          api: "future-api",
          baseUrl: "http://127.0.0.1:9",
          requiresApiKey: false,
          models: [{ id: "m1" }],
        },
      },
    });
    expect(await h.run(["-p", "--model", "future/m1", "hi"])).toBe(4);
    expect(h.stderr()).toContain("协议 future-api 尚未实现");
  });
});
