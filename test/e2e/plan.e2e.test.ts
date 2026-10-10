/**
 * [W5-Z] Plan 模式（docs/guides/plan.md「审批」）bundle 级：`-p` 无人值守缺省 stop → 计划落盘、退出码 9；
 * 用户级 `plan.unattended: "approve"` 时同一次运行里自动批准并执行。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { hasBundle, runAma } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const PLAN = [
  "Here is the plan.",
  "",
  "<proposed_plan>",
  "",
  "# Add greeting",
  "",
  "## 步骤",
  "",
  "- [ ] S1 Create greet.txt",
  "- [ ] S2 Report back",
  "",
  "</proposed_plan>",
].join("\n");

function planFiles(h: TmpHome): string[] {
  const dir = join(h.dataDir, "plans");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe.skipIf(!hasBundle)("e2e：Plan（bundle 子进程）", () => {
  it("-p + plan 模式、缺省 unattended stop：计划落盘不执行，json 带 planPending，退出 9", async () => {
    home = createTmpHome();
    const script = home.write("script.json", {
      version: 1,
      responses: [{ text: PLAN }, { text: "should not run" }],
    });
    const r = await runAma(
      home,
      [
        "-p",
        "plan it",
        "--model",
        "fake/echo",
        "--permission-mode",
        "plan",
        "--output-format",
        "json",
      ],
      { env: { AMA_FAKE_SCRIPT: script } },
    );
    expect(r.code).toBe(9);
    const result = JSON.parse(r.stdout) as { planPending?: { version: number; filePath: string } };
    expect(result.planPending).toMatchObject({ version: 1 });
    expect(existsSync(result.planPending!.filePath)).toBe(true);
    expect(planFiles(home)).toHaveLength(1);
    expect(r.stdout).not.toContain("should not run");
  });

  it("plan.unattended: approve：同一次运行里批准，步骤转 todo 并执行，退出 0", async () => {
    home = createTmpHome();
    home.write("home/.config/ama/config.json", { version: 1, plan: { unattended: "approve" } });
    const script = home.write("script.json", {
      version: 1,
      responses: [{ text: PLAN }, { text: "executed the plan" }],
    });
    const r = await runAma(
      home,
      [
        "-p",
        "plan it",
        "--model",
        "fake/echo",
        "--permission-mode",
        "plan",
        "--output-format",
        "stream-json",
      ],
      { env: { AMA_FAKE_SCRIPT: script } },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const events = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
    const types = events.map((e) => e.type);
    expect(types).toContain("plan_proposed");
    expect(events.find((e) => e.type === "plan_resolved")).toMatchObject({ decision: "approve" });
    const todos = events.find((e) => e.type === "todo_updated") as { items?: unknown[] };
    expect(todos?.items).toHaveLength(2);
    expect(r.stdout).toContain("executed the plan");
    expect(planFiles(home)).toHaveLength(1);
  });
});
