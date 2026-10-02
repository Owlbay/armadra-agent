import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import type { ToolResultMessage } from "../ai/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { isChild, lastIsToolResult, subagentHarness } from "./testing/subagent-harness.js";
import { stubTool } from "./testing/stubs.js";
import type { SessionEvent } from "./types.js";
import { createWorktree, finishWorktree, runGit } from "./worktree.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function repo(): string {
  home = createTmpHome("ama-w5g-wt-");
  const root = join(home.root, "repo");
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "a.txt"), "one\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      stdio: "ignore",
    });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return realpathSync.native(root);
}

describe.skipIf(!hasGit)("worktree 隔离（需要 git）", () => {
  it("非 git 目录报错，不回落共享目录", async () => {
    home = createTmpHome("ama-w5g-wt-");
    await expect(createWorktree(home.cwd, "t1")).rejects.toThrow(/needs a git repository/);
  });

  it("无改动：删除 worktree 与分支；子 cwd 对应父的子目录；.ama/worktrees 被忽略", async () => {
    const root = repo();
    const tree = await createWorktree(join(root, "pkg"), "t1");
    expect(tree.branch).toBe("ama/task-t1");
    expect(tree.cwd).toBe(join(root, ".ama", "worktrees", "t1", "pkg"));
    expect(readFileSync(join(tree.cwd, "a.txt"), "utf8")).toBe("one\n");
    expect((await runGit(["status", "--porcelain"], root)).trim()).toBe("");
    const outcome = await finishWorktree(tree);
    expect(outcome).toEqual({ branch: "ama/task-t1", changed: false });
    expect(existsSync(tree.path)).toBe(false);
    expect(await runGit(["branch", "--list", "ama/task-t1"], root)).toBe("");
  });

  it("有改动：保留并给分支与 diff 摘要（含未跟踪文件）", async () => {
    const root = repo();
    const tree = await createWorktree(root, "t2");
    writeFileSync(join(tree.cwd, "pkg", "a.txt"), "two\n");
    writeFileSync(join(tree.cwd, "new.txt"), "x");
    const outcome = await finishWorktree(tree);
    expect(outcome).toMatchObject({ branch: "ama/task-t2", changed: true, path: tree.path });
    expect(outcome.diffStat).toContain("pkg/a.txt");
    expect(outcome.diffStat).toContain("untracked: new.txt");
    expect(existsSync(tree.path)).toBe(true);
  });

  it("task isolation worktree：子会话在 worktree 里跑；有改动保留、无改动删除；事件带 worktree", async () => {
    const root = repo();
    const touch = stubTool({
      name: "touch",
      run: (_input, ctx) => {
        writeFileSync(join(ctx.cwd, "made-by-child.txt"), ctx.cwd);
        return { content: "touched" };
      },
    }) as ToolDefinition;
    const h = subagentHarness({
      cwd: root,
      extraTools: [touch],
      script: (call) => {
        if (isChild(call)) {
          const first = call.context.messages.find((m) => m.role === "user");
          const prompt = first?.role === "user" ? String(first.content) : "";
          if (prompt === "change" && !lastIsToolResult(call))
            return { toolCalls: [{ name: "touch", args: {} }] };
          return { text: `child done (${prompt})` };
        }
        return lastIsToolResult(call)
          ? { text: "parent done" }
          : {
              toolCalls: [
                { name: "task", args: { prompt: "change", isolation: "worktree" } },
                { name: "task", args: { prompt: "look", isolation: "worktree" } },
              ],
            };
      },
    });
    await h.session.prompt("go");
    const results = h.session.messages.filter(
      (m): m is ToolResultMessage => m.role === "toolResult",
    );
    const changed = String(results[0]?.content);
    const prefix = h.manager.id.slice(0, 8);
    expect(changed).toContain(`[worktree kept: branch ama/task-${prefix}-t1`);
    expect(changed).toContain("untracked: made-by-child.txt");
    const made = join(root, ".ama", "worktrees", `${prefix}-t1`, "made-by-child.txt");
    expect(readFileSync(made, "utf8")).toBe(join(root, ".ama", "worktrees", `${prefix}-t1`));
    expect(existsSync(join(root, "made-by-child.txt"))).toBe(false);
    expect(existsSync(join(root, ".ama", "worktrees", `${prefix}-t2`))).toBe(false);
    const ends = h.events.filter(
      (e): e is Extract<SessionEvent, { type: "subagent_end" }> => e.type === "subagent_end",
    );
    expect(Object.fromEntries(ends.map((e) => [e.taskId, e.worktree]))).toEqual({
      t1: { branch: `ama/task-${prefix}-t1`, changed: true },
      t2: { branch: `ama/task-${prefix}-t2`, changed: false },
    });
    expect((await runGit(["status", "--porcelain"], root)).trim()).toBe("");
    await h.session.dispose();
  });
});
