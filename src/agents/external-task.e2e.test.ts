/**
 * 真实外部 CLI 经 `task(agent=…)` 的端到端（W5-EG）：只在本地、`AMA_E2E_AGENTS=1` 时跑，CI 永不设置。
 * 需要已登录的 `claude` / `codex`——**会使用你的订阅额度**（每家约 2 个小请求）。父会话用 fake 供应商
 * （零费用），只有外部 CLI 计费。
 *
 *   AMA_E2E_AGENTS=1 pnpm vitest run src/agents/external-task.e2e.test.ts
 *
 * 每家：父 ama 以 `task(agent=<id>)` 让它在临时项目里写一个文件（首次运行确认 + 写文件审批都由
 * 测试代替人点「允许」），再以 `task{taskId}` 续聊一轮（同一外部会话）。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { ApprovalRequest } from "../permissions/types.js";

const enabled = process.env["AMA_E2E_AGENTS"] === "1";
let h: ComposeHarness | undefined;
afterEach(() => h?.cleanup());

async function delegate(agent: string) {
  h = composeHarness([
    {
      steps: [
        {
          toolCall: {
            name: "task",
            arguments: {
              agent,
              prompt: `Create a file named note-${agent}.txt in the current directory containing the word hi. Then reply DONE.`,
            },
          },
        },
      ],
    },
    {
      steps: [
        {
          toolCall: { name: "task", arguments: { taskId: "t1", prompt: "Reply with exactly OK." } },
        },
      ],
    },
    { text: "parent done" },
  ]);
  const runtime = await h.boot(["--model", "fake/echo", "--tools", "read,task", "--trust"]);
  const asked: ApprovalRequest[] = [];
  runtime.approvals.setUiBroker({
    ask: async (request) => {
      asked.push(request);
      return "allow";
    },
  });
  await runtime.session.prompt("delegate");
  const results = runtime.session.messages
    .filter((m) => "role" in m && m.role === "toolResult")
    .map((m) => JSON.stringify((m as { content: unknown }).content));
  const cwd = h.home.cwd;
  await runtime.dispose();
  return { results, asked, cwd };
}

describe.skipIf(!enabled)("真实外部 CLI 经 task（本地）", () => {
  for (const agent of ["claude", "codex"]) {
    it(`${agent}：首次确认 + 写文件审批交人；taskId 续聊同一外部会话`, async () => {
      const r = await delegate(agent);
      expect(r.asked.map((a) => a.toolName)).toContain(`agent:${agent}`);
      expect(r.asked.find((a) => a.toolName === `agent:${agent}`)?.context).toMatchObject({
        taskId: "t1",
        origin: { agent },
      });
      expect(existsSync(join(r.cwd, `note-${agent}.txt`))).toBe(true);
      expect(r.results[0]).toContain("[task t1]");
      expect(r.results[1]).toMatch(/OK/);
    }, 300_000);
  }
});
