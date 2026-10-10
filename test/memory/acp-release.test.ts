/**
 * ACP 关闭会话后可回收（docs/memory-plan.md D2、§2.2、§3「[M-A]」测试 1）。[M-A]
 *
 * fake 下开 6 个会话各跑 2 轮（第一轮读一张图），逐个 `session/close` 后：会话实例全部被回收（含被
 * 第一个 `session/new` 认领的启动会话，#165；只剩关掉最后一个会话时补的待命会话）、子 Agent 控制面
 * 已注销、共享缓存报告表不持有转录与回调、图片占的内存回到基线附近。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionImpl } from "../../src/agent/session.js";
import { taskControl } from "../../src/agents/task-control.js";
import { sharedCacheReporting } from "../../src/ai/cache/reporting.js";
import type { FakeResponse } from "../../src/ai/fake/fake-script.js";
import { emptyArgs } from "../../src/cli/args.js";
import { currentSession } from "../../src/cli/compose-session.js";
import { AcpClient } from "../../src/drivers/acp/client.js";
import { memoryTransport } from "../../src/drivers/test-support.js";
import { runAcpMode } from "../../src/modes/acp/acp-mode.js";
import { assertAcpWire } from "../helpers/acp-schema.js";
import { composeHarness, type ComposeHarness } from "../helpers/compose-harness.js";
import { gcUntil, sampleMemory, trackInstances } from "../helpers/memory.js";

const SESSIONS = 6;
const IMAGE_BYTES = 1536 * 1024;

let h: ComposeHarness | undefined;
afterEach(() => h?.cleanup());

/** 只有文件头可信的 PNG（read 只取尺寸，不解码像素）；每张内容不同，不会被去重。 */
function png(seed: number): Buffer {
  const head = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000000000000008060000001f15c489",
    "hex",
  );
  head.writeUInt32BE(64, 16);
  head.writeUInt32BE(64, 20);
  return Buffer.concat([head, Buffer.alloc(IMAGE_BYTES - head.length, seed + 1)]);
}

/** 每个会话：读图 → 收尾；第二轮纯文本。 */
function script(): FakeResponse[] {
  const responses: FakeResponse[] = [];
  for (let i = 0; i < SESSIONS; i++) {
    responses.push(
      { steps: [{ toolCall: { name: "read", arguments: { path: `img${i}.png` } } }] },
      { text: `seen ${i}` },
      { text: `round two ${i}` },
    );
  }
  return responses;
}

/** 共享缓存报告表的端点摘要（私有字段，只在测试里看）。 */
function endpointLasts(): unknown[] {
  const endpoints = (
    sharedCacheReporting as unknown as { endpoints: Map<string, { last: unknown }> }
  ).endpoints;
  return [...endpoints.values()].map((e) => e.last);
}

const heapAndOffHeap = (): number => {
  const s = sampleMemory();
  return s.heapUsed + s.external + s.arrayBuffers;
};

describe("ACP 会话关闭后可回收 [M-A]", () => {
  it("6 个会话各 2 轮（含读图）→ 逐个 close：实例回收、控制面注销、图片内存回到基线", async () => {
    h = composeHarness(script());
    const harness = h;
    for (let i = 0; i < SESSIONS; i++) writeFileSync(join(harness.home.cwd, `img${i}.png`), png(i));
    const runtime = await harness.boot([
      "--mode",
      "rpc",
      "--model",
      "fake/echo",
      "--tools",
      "read",
      "--permission-mode",
      "full-auto",
    ]);
    let exit!: Promise<number>;
    const mem = memoryTransport((input, output) => {
      exit = runAcpMode(
        runtime,
        { args: emptyArgs(), prompt: undefined, io: harness.io },
        { stdin: input, stdout: output },
      );
      return exit;
    });
    const client = new AcpClient({
      input: mem.transport.stdout,
      output: mem.transport.stdin,
      clientInfo: { name: "test", version: "0" },
    });
    await client.initialize();

    const tracker = trackInstances(AgentSessionImpl);
    const ids: string[] = [];
    // 在独立函数里取会话：async 测试体挂起时会留住循环里的局部变量
    const track = (sessionId: string): void => {
      const session = currentSession(runtime);
      expect(session.state.sessionId).toBe(sessionId);
      tracker.add(session as AgentSessionImpl);
    };
    /** 开一个会话跑两轮：读第 i 张图 → 纯文本。 */
    const runSession = async (i: number): Promise<void> => {
      const { sessionId } = await client.newSession(runtime.paths.cwd);
      ids.push(sessionId);
      for (const text of [`read img${i}.png`, "again"]) {
        const r = await client.prompt(sessionId, [{ type: "text", text }]);
        expect(r.stopReason).toBe("end_turn");
      }
      track(sessionId);
    };
    // fake 记下的请求上下文与选项（onQuota 闭包）持有转录与会话，测量前丢掉（D12 之前的测试基建限制；
    // 不能清空数组——脚本按 calls.length 取下一条）
    const dropFakeCalls = (): void => {
      for (const call of harness.fake.calls as { context?: unknown; options?: unknown }[]) {
        call.context = undefined;
        call.options = {};
      }
    };

    // 热身：第一个会话认领启动会话、加载读图与模型目录等惰性模块；之后取基线
    await runSession(0);
    dropFakeCalls();
    await gcUntil(() => false, 3);
    const baseline = heapAndOffHeap();

    for (let i = 1; i < SESSIONS; i++) await runSession(i);
    expect(tracker.created).toBe(SESSIONS);
    expect(ids.every((id) => taskControl(id) !== undefined)).toBe(true);
    dropFakeCalls();
    await gcUntil(() => false, 3);
    const open = heapAndOffHeap() - baseline;
    // 5 张图都还在（实测约 9.4 MB）
    expect(open).toBeGreaterThan((SESSIONS - 1) * IMAGE_BYTES);

    for (const sessionId of ids) await client.closeSession(sessionId);
    for (const sessionId of ids) expect(taskControl(sessionId)).toBeUndefined();
    expect(endpointLasts().length).toBeGreaterThan(0);
    for (const last of endpointLasts())
      expect(Object.keys(last as object).sort()).toEqual(["at", "fingerprint", "promptTokens"]);

    expect(await gcUntil(() => tracker.alive === 0)).toBe(true);
    await gcUntil(() => false, 3);
    const closed = heapAndOffHeap() - baseline;
    // 图片全部释放，含基线里启动会话那张（#165；实测约 −3.4 MB，补的待命会话约 0.8 MB 已计入）；
    // 启动会话或任何一张图没放都会超
    expect(closed).toBeLessThan(0);

    mem.transport.stdin.end();
    expect(await exit).toBe(0);
    await runtime.dispose();
    assertAcpWire(mem.wire);
  });
});
