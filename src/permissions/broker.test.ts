import { describe, expect, it } from "vitest";
import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "./types.js";
import { ApprovalBrokerChain, authorize, type AnsweredBy } from "./broker.js";
import { PermissionPipeline } from "./pipeline.js";

const req = (id = "r1"): ApprovalRequest => ({
  requestId: id,
  toolName: "bash",
  input: { command: "ls" },
  reason: "mode",
});
const signal = () => new AbortController().signal;
const answer = (d: ApprovalDecision | undefined): ApprovalBroker => ({ ask: async () => d });

describe("ApprovalBrokerChain", () => {
  it("宿主 → UI：undefined 交给下一个", async () => {
    const log: [string, ApprovalDecision, AnsweredBy][] = [];
    const chain = new ApprovalBrokerChain({
      onResolved: (r, d, by) => log.push([r.requestId, d, by]),
    });
    chain.setHostBroker(answer(undefined));
    chain.setUiBroker(answer("allow"));
    expect(await chain.ask(req(), signal())).toBe("allow");
    chain.setHostBroker(answer("deny"));
    expect(await chain.ask(req("r2"), signal())).toBe("deny");
    expect(log).toEqual([
      ["r1", "allow", "ui"],
      ["r2", "deny", "host"],
    ]);
  });

  it("没有回答者 → 无人值守 deny", async () => {
    const chain = new ApprovalBrokerChain();
    expect(chain.hasResponder()).toBe(false);
    expect(await chain.ask(req(), signal())).toBe("deny");
    chain.setUiBroker(answer(undefined));
    expect(chain.hasResponder()).toBe(true);
    expect(await chain.ask(req(), signal())).toBe("deny");
  });

  it("回答者抛错 → deny（fail-safe）", async () => {
    const warnings: string[] = [];
    const chain = new ApprovalBrokerChain({ log: (_l, m) => warnings.push(m) });
    chain.setHostBroker({ ask: async () => Promise.reject(new Error("boom")) });
    chain.setUiBroker(answer("allow"));
    expect(await chain.ask(req(), signal())).toBe("deny");
    expect(warnings[0]).toContain("boom");
  });

  it("超时 deny，且回答者收到的 signal 被 abort", async () => {
    let seen: AbortSignal | undefined;
    const by: AnsweredBy[] = [];
    const chain = new ApprovalBrokerChain({ timeoutMs: 50, onResolved: (_r, _d, b) => by.push(b) });
    chain.setUiBroker({
      ask: (_r, s) => {
        seen = s;
        return new Promise(() => undefined);
      },
    });
    expect(await chain.ask(req(), signal())).toBe("deny");
    expect(seen?.aborted).toBe(true);
    expect(by).toEqual(["timeout"]);
  });

  it("父 abort → deny", async () => {
    const chain = new ApprovalBrokerChain();
    chain.setUiBroker({ ask: () => new Promise(() => undefined) });
    const c = new AbortController();
    const p = chain.ask(req(), c.signal);
    c.abort();
    expect(await p).toBe("deny");
    const pre = new AbortController();
    pre.abort();
    expect(await chain.ask(req(), pre.signal)).toBe("deny");
  });

  it("审批串行化", async () => {
    const order: string[] = [];
    const chain = new ApprovalBrokerChain();
    chain.setUiBroker({
      ask: async (r) => {
        order.push(`start ${r.requestId}`);
        await new Promise((res) => setTimeout(res, 20));
        order.push(`end ${r.requestId}`);
        return "allow";
      },
    });
    await Promise.all([chain.ask(req("a"), signal()), chain.ask(req("b"), signal())]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });
});

describe("authorize", () => {
  const make = () => new PermissionPipeline({ mode: "default", rules: [], cwd: "/w" });
  const input = (unattended = false) => ({
    toolName: "bash",
    permission: "execute" as const,
    input: { command: "make build" },
    unattended,
  });

  it("allow 直接放行；deny 带说明", async () => {
    const chain = new ApprovalBrokerChain();
    const p = make();
    const read = await authorize(
      p,
      chain,
      { toolName: "read", permission: "read", input: { path: "a" }, unattended: false },
      { signal: signal() },
    );
    expect(read.allowed).toBe(true);
    const un = await authorize(p, chain, input(true), { signal: signal() });
    expect(un).toMatchObject({ allowed: false });
    expect(un.message).toContain("unattended");
  });

  it("allow_session 记忆后不再询问；hook ask 带 hookReason", async () => {
    const asked: ApprovalRequest[] = [];
    const chain = new ApprovalBrokerChain({ onRequested: (r) => asked.push(r) });
    chain.setUiBroker(answer("allow_session"));
    const p = make();
    const first = await authorize(p, chain, input(), { signal: signal(), requestId: "q1" });
    expect(first).toMatchObject({ allowed: true, decision: "allow_session" });
    const second = await authorize(p, chain, input(), { signal: signal() });
    expect(second).toMatchObject({ allowed: true, verdict: { step: "session" } });
    expect(asked.map((r) => r.requestId)).toEqual(["q1"]);

    chain.setUiBroker(answer("deny"));
    const hooked = await authorize(
      p,
      chain,
      {
        toolName: "read",
        permission: "read",
        input: { path: "x" },
        hookDecision: "ask",
        hookReason: "check this",
        unattended: false,
      },
      { signal: signal() },
    );
    expect(hooked.allowed).toBe(false);
    expect(asked.at(-1)).toMatchObject({ reason: "hook", hookReason: "check this" });
  });
});
