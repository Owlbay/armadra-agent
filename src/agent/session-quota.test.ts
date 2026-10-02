/**
 * [W6-O] 订阅配额与订阅用量：协议层 onQuota → `quota_update` 事件；`billing: "subscription"` 的请求进
 * `getStats().subscription`，`/session` 单列「订阅用量」并显示最近配额。
 */

import { describe, expect, it } from "vitest";
import { describeSession, subscriptionRows } from "../modes/session-report.js";
import { createHarness } from "./testing/harness.js";

describe("订阅配额与用量", () => {
  it("onQuota → quota_update；订阅请求单列；/session 显示", async () => {
    const h = createHarness({
      script: (call) => {
        call.options.onQuota?.({
          planType: "plus",
          primary: { usedPercent: 42, windowMinutes: 300 },
          secondary: { usedPercent: 18, windowMinutes: 10_080 },
        });
        return {
          text: "ok",
          usage: { input: 100, output: 20, cacheRead: 300, billing: "subscription" },
        };
      },
    });
    await h.session.prompt("hi");
    const event = h.events.find((e) => e.type === "quota_update");
    expect(event).toEqual({
      type: "quota_update",
      provider: h.model.provider,
      planType: "plus",
      primary: { usedPercent: 42, windowMinutes: 300 },
      secondary: { usedPercent: 18, windowMinutes: 10_080 },
    });
    const stats = h.session.getStats();
    expect(stats.subscription).toEqual({
      requests: 1,
      byProvider: { [h.model.provider]: { requests: 1, input: 100, output: 20, cacheRead: 300 } },
      quota: event,
    });
    expect(subscriptionRows(h.session).map((r) => r.value)).toEqual([
      "1 次请求 · 输入 100 · 输出 20 · 缓存读 300（命中率 75%）· 不折算美元",
      "5 小时 42% · 周 18%",
    ]);
    expect(describeSession(h.session)).toContain("订阅用量");
  });

  it("没有订阅请求：subscription 缺省，/session 不出现该段", async () => {
    const h = createHarness({ script: [{ text: "ok" }] });
    await h.session.prompt("hi");
    expect(h.session.getStats().subscription).toBeUndefined();
    expect(describeSession(h.session)).not.toContain("订阅用量");
  });
});

describe("宿主事件桥", () => {
  it("quota_update → 宿主 quota_update（去掉 type）", async () => {
    const { bridgeEvent } = await import("../cli/compose-session.js");
    const { AgentEventBus } = await import("../host/api-impl.js");
    const bus = new AgentEventBus();
    const seen: unknown[] = [];
    bus.on("quota_update", (event) => void seen.push(event));
    bridgeEvent({ type: "quota_update", provider: "chatgpt", primary: { usedPercent: 1 } }, bus);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ provider: "chatgpt", primary: { usedPercent: 1 } }]);
  });
});
