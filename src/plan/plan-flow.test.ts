/**
 * [W5-F] 组装后的端到端（docs/wave5-plan.md §6.6）：
 * - 缓存前缀：20 回合里 plan ↔ default 切换 3 次，system + tools 逐字节不变，`cache_miss` 没有 prefix_changed；
 * - 交接：`-p` + `plan.unattended: approve` 在一次运行里 plan → 批准 → todo → 执行模式；缺省 stop 只落盘。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import type { Model, TranscriptContext } from "../ai/types.js";
import type { SessionEvent } from "../agent/types.js";
import { SessionManager } from "../session/manager.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

const registry = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } });
const anthropic = registry.get("anthropic")?.models[0] as Model;
const signal = new AbortController().signal;

function prefix(context: TranscriptContext): string {
  const body = buildAnthropicRequest(anthropic, context, { signal, cacheRetention: "short" }).body;
  return JSON.stringify({ system: body["system"], tools: body["tools"] }, (key, value: unknown) =>
    key === "cache_control" ? undefined : value,
  );
}

const PLAN_REPLY = [
  "<proposed_plan>",
  "# Add greeting",
  "## Steps",
  "- [ ] S1 Read src/hello.ts",
  "- [ ] S2 Add the greeting",
  "## Verification",
  "- pnpm test",
  "</proposed_plan>",
].join("\n");

describe("plan 与缓存前缀（§9.1）", () => {
  it("20 回合中 plan ↔ default 切换 3 次：前缀逐字节不变，没有 prefix_changed", async () => {
    const script: FakeResponse[] = Array.from({ length: 20 }, (_, i) => ({
      text: `answer ${i}`,
      usage: { input: 100, output: 5, cacheRead: i === 0 ? 0 : 900, cacheWrite: i === 0 ? 900 : 0 },
    }));
    h = composeHarness(script);
    const runtime = await h.boot(["--model", "fake/echo"]);
    const events: SessionEvent[] = [];
    runtime.session.subscribe((event) => events.push(event));
    const toggles: Record<number, "plan" | "default"> = {
      3: "plan",
      6: "default",
      9: "plan",
      12: "default",
      15: "plan",
      18: "default",
    };
    for (let i = 0; i < 20; i++) {
      const mode = toggles[i];
      if (mode !== undefined) runtime.session.setPermissionMode(mode);
      await runtime.session.prompt(`question ${i}`);
    }
    expect(h.fake.calls).toHaveLength(20);
    const first = prefix(h.fake.calls[0]!.context);
    for (const call of h.fake.calls) expect(prefix(call.context)).toBe(first);
    const misses = events.filter((e) => e.type === "cache_miss");
    expect(misses.filter((e) => e.type === "cache_miss" && e.reason === "prefix_changed")).toEqual(
      [],
    );
    const injected = runtime.session.entries.flatMap((e) =>
      e.type === "custom_message" ? [e.customType] : [],
    );
    expect(injected.filter((t) => t === "ama.plan_mode")).toHaveLength(3);
    expect(injected.filter((t) => t === "ama.plan_mode_exit")).toHaveLength(3);
    await runtime.dispose();
  });
});

describe("-p 下的计划审批", () => {
  it("缺省 stop：落盘计划文件后停下，不切模式、不执行", async () => {
    h = composeHarness([{ text: PLAN_REPLY }, { text: "should not run" }]);
    const code = await h.run(["-p", "--model", "fake/echo", "--permission-mode", "plan", "plan"]);
    expect(code).toBe(9); // [W5-H2] 计划待审批：退出码 9（print-mode.test.ts 有完整用例）
    expect(h.fake.calls).toHaveLength(1);
    const plans = readdirSync(join(h.home.dataDir, "plans"));
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatch(/-v1\.md$/);
  });

  it("plan.unattended: approve：同一次运行里批准、生成 todo、切到执行模式并继续", async () => {
    h = composeHarness([{ text: PLAN_REPLY }, { text: "implemented" }]);
    h.home.write("home/.config/ama/config.json", { version: 1, plan: { unattended: "approve" } });
    const code = await h.run([
      "-p",
      "--model",
      "fake/echo",
      "--permission-mode",
      "plan",
      "--output-format",
      "json",
      "plan",
    ]);
    expect(h.stderr()).toBe("");
    expect(code).toBe(0);
    expect(h.fake.calls).toHaveLength(2);
    const result = JSON.parse(h.stdout().trim().split("\n").at(-1)!) as {
      text: string;
      sessionFile: string;
    };
    expect(result.text).toBe("implemented");
    const entries = SessionManager.open(result.sessionFile).branch();
    const todo = entries.filter((e) => e.type === "custom" && e.customType === "ama.todo").at(-1);
    expect(todo).toMatchObject({ data: { items: [{ id: "S1", status: "in_progress" }, {}] } });
    const state = entries
      .filter((e) => e.type === "custom" && e.customType === "ama.plan_state")
      .at(-1);
    expect(state).toMatchObject({ data: { active: false, prePlanMode: "default" } });
    expect(existsSync(join(h.home.dataDir, "plans"))).toBe(true);
  });
});
