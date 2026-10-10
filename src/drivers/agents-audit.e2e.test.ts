/**
 * 外部 Agent 驱动的逐路径实测（#198）：只在本地、设置 `AMA_E2E_AUDIT` 时跑，CI 永不设置。
 * **会使用各 CLI 的订阅或额度**：每条路径起两个会话。
 *
 *   AMA_E2E_AUDIT="claude/claude-stream@haiku,codex/oneshot@gpt-6-luna" \
 *     pnpm vitest run src/drivers/agents-audit.e2e.test.ts
 *
 * 每项 `<agent>/<驱动种类>[@模型]`：驱动种类取驱动表里该 Agent 的候选（`acp` / `acp-adapter` /
 * `claude-stream` / `codex-app-server` / `oneshot` / `pi-rpc`），强制只用这一条路径。
 * - 会话 A（非 git 临时目录）：两轮「只回 OK」，再一轮触发审批的写文件（测试代替人点「允许」；
 *   一次性打印模式只能只读，跳过写文件）；
 * - 会话 B（git 临时目录）：长输出时中断，再一轮「只回 OK」确认会话仍可续。
 * 结果（文本、审批次数、用量、上下文、提示）写到 `AMA_E2E_AUDIT_OUT`（缺省打印到 stdout）。
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PermissionMode } from "../permissions/types.js";
import type { SubagentEvent, SubagentResult } from "../tools/types.js";
import { createDriver } from "./agents.js";
import { catalogEntry } from "./catalog.js";
import { poolFromConfig } from "./pool.js";
import { ProgramProbe } from "./probe.js";
import { ProcessRunner } from "./runner.js";

const specs = (process.env["AMA_E2E_AUDIT"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const out = process.env["AMA_E2E_AUDIT_OUT"];
const dirs: string[] = [];
afterAll(() => {
  if (process.env["AMA_E2E_AUDIT_KEEP"] !== "1")
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(git: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), git ? "ama-audit-git-" : "ama-audit-")));
  dirs.push(dir);
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function report(record: Record<string, unknown>): void {
  const line = `${JSON.stringify(record)}\n`;
  if (out !== undefined) appendFileSync(out, line);
  else process.stdout.write(line);
}

function summarize(result: SubagentResult, events: SubagentEvent[]) {
  const usage = events.filter((e) => e.type === "usage") as Extract<
    SubagentEvent,
    { type: "usage" }
  >[];
  const notices = events.flatMap((e) => (e.type === "notice" ? [e.text] : []));
  return {
    status: result.status,
    stop: result.stopReason,
    error: result.isError,
    text: result.text.slice(0, 160),
    usage: result.usage,
    context: usage.filter((u) => "contextTokens" in u || "contextWindow" in u).at(-1),
    notices,
  };
}

function parse(spec: string): { agent: string; kind: string; model?: string } {
  const [path, model] = spec.split("@") as [string, string | undefined];
  const [agent, kind] = path.split("/") as [string, string];
  return { agent, kind, ...(model !== undefined && model !== "" ? { model } : {}) };
}

function runnerFor(agent: string, kind: string, asked: string[]) {
  const candidate = catalogEntry(agent)?.candidates.find((c) => c.kind === kind);
  if (candidate === undefined) throw new Error(`no ${kind} candidate for ${agent}`);
  const probe = new ProgramProbe({ env: process.env });
  const driver = createDriver(agent, candidate, { probe });
  const runner = new ProcessRunner([driver], {
    env: process.env,
    pool: poolFromConfig(undefined),
    trusted: () => true,
    approve: async (req) => {
      asked.push(req.context?.origin?.toolCall.title ?? req.toolName);
      return "allow";
    },
  });
  return { runner, driver, candidate };
}

async function sessionA(agent: string, kind: string, model: string | undefined) {
  const cwd = tempDir(false);
  const asked: string[] = [];
  const events: SubagentEvent[] = [];
  const { runner, driver } = runnerFor(agent, kind, asked);
  const probed = await driver.probe();
  const mode: PermissionMode = kind === "oneshot" ? "plan" : "default";
  const started = Date.now();
  const handle = await runner.start({
    prompt: "Reply with exactly OK and nothing else.",
    cwd,
    mode,
    ...(model !== undefined ? { model } : {}),
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });
  const first = summarize(await handle.wait(), events.splice(0));
  await handle.send("Reply with exactly OK again and nothing else.");
  const second = summarize(await handle.wait(), events.splice(0));
  let write: ReturnType<typeof summarize> | undefined;
  const file = join(cwd, "note.txt");
  if (mode !== "plan") {
    await handle.send(
      "Create a file named note.txt in the current directory containing the single word hi. Use your file-writing tool, then reply DONE.",
    );
    write = summarize(await handle.wait(), events.splice(0));
  }
  await handle.stop();
  return {
    version: probed.version,
    mode,
    sessionId: handle.id,
    first,
    second,
    write,
    asked,
    wrote: existsSync(file),
    ms: Date.now() - started,
  };
}

async function sessionB(agent: string, kind: string, model: string | undefined) {
  const cwd = tempDir(true);
  const asked: string[] = [];
  const events: SubagentEvent[] = [];
  const { runner } = runnerFor(agent, kind, asked);
  const controller = new AbortController();
  let sawText = false;
  let interruptAt = 0;
  const handle = await runner.start({
    prompt:
      "Without using any tools, write the integers from 1 to 400, one per line, then reply END.",
    cwd,
    mode: kind === "oneshot" ? "plan" : "default",
    ...(model !== undefined ? { model } : {}),
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e);
      if (!sawText && e.type === "text") sawText = true;
    },
  });
  // 首个文本增量到来（或 20 s）后中断
  for (let i = 0; i < 200 && !sawText; i++) await new Promise((r) => setTimeout(r, 100));
  interruptAt = Date.now();
  const interrupted = handle.interrupt
    ? await handle.interrupt("Reply with exactly OK and nothing else.")
    : false;
  // 不能中断单个回合的驱动（一次性打印）：中断 = 结束进程，这里只记结束耗时
  if (!interrupted) await handle.stop();
  const after = summarize(await handle.wait(), events.splice(0));
  const ms = Date.now() - interruptAt;
  await handle.stop();
  return { sawText, interrupted, after, interruptToEndMs: ms, asked };
}

describe.skipIf(specs.length === 0)("外部 Agent 逐路径实测（本地）", () => {
  for (const spec of specs) {
    const { agent, kind, model } = parse(spec);
    it(`${spec}：非 git 两轮 + 审批写文件`, async () => {
      try {
        const a = await sessionA(agent, kind, model);
        report({ spec, case: "A", ...a });
        expect(a.first.text).toMatch(/OK/);
      } catch (error) {
        report({ spec, case: "A", failed: String((error as Error).message ?? error) });
        throw error;
      }
    }, 600_000);
    it(`${spec}：git 目录中断后续聊`, async () => {
      if (process.env["AMA_E2E_AUDIT_SKIP_B"] === "1") return;
      try {
        const b = await sessionB(agent, kind, model);
        report({ spec, case: "B", ...b });
      } catch (error) {
        report({ spec, case: "B", failed: String((error as Error).message ?? error) });
        throw error;
      }
    }, 600_000);
  }
});
