/**
 * 继续 / 恢复会话跳过子 Agent（task）会话：`-c`、选择器（listSessions）、`sessions list`；
 * 显式 `--resume <子会话 id>` 仍可打开；fork 会话（也带 parentSession）照常算主会话。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { createSessionStore, listSessions, openSession } from "../cli/compose-store.js";
import type { CliIo } from "../cli/deps.js";
import { defaultIo } from "../cli/main.js";
import { runSessions } from "../cli/subcommands/sessions.js";
import { SessionManager } from "./manager.js";
import { isSubagentSessionFile, sessionDirForCwd } from "./store.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const at = (minute: number) => () => new Date(Date.UTC(2026, 0, 1, 1, minute, 0));

function persist(manager: SessionManager, prompt: string): SessionManager {
  manager.append({
    type: "message",
    message: { role: "user", content: prompt, timestamp: 1 },
  });
  manager.flush();
  return manager;
}

/** 主会话（1 分）→ 子 Agent 会话（2 分，与 session-subagent 的 childManager 同形）。 */
function seed() {
  home = createTmpHome("ama-subagent-sessions-");
  const root = home.path("sessions");
  const dir = sessionDirForCwd(root, home.cwd);
  const parent = persist(SessionManager.create(dir, home.cwd, { now: at(1) }), "main task");
  const parentFile = parent.file() ?? "";
  const child = SessionManager.create(dir, home.cwd, {
    now: at(2),
    parentSession: parentFile,
  });
  child.append({
    type: "custom",
    customType: "ama.task",
    data: { taskId: "t1", agent: "explore", parentSession: parentFile },
  });
  persist(child, "explore the repo");
  parent.close();
  child.close();
  return { root, dir, cwd: home.cwd, parentId: parent.id, childId: child.id, child };
}

describe("子 Agent 会话不进继续 / 恢复列表", () => {
  it("识别只看头两行：子会话是，主会话不是", () => {
    const s = seed();
    expect(isSubagentSessionFile(s.child.file() ?? "")).toBe(true);
    const [main] = listSessions({ sessionDir: s.root, cwd: s.cwd });
    expect(main?.id).toBe(s.parentId);
    expect(isSubagentSessionFile(main?.file ?? "")).toBe(false);
  });

  it("-c 跳过更新的子会话，打开主会话", () => {
    const s = seed();
    const opened = openSession({ kind: "continue" }, { sessionDir: s.root, cwd: s.cwd });
    try {
      expect(opened.id).toBe(s.parentId);
    } finally {
      opened.close();
    }
  });

  it("-c 不跳过 fork 出来的会话（同样带 parentSession）", () => {
    const s = seed();
    const source = SessionManager.open(
      listSessions({ sessionDir: s.root, cwd: s.cwd })[0]?.file ?? "",
    );
    const forked = source.fork(source.leafId() ?? "");
    source.close();
    forked.close();
    const opened = openSession({ kind: "continue" }, { sessionDir: s.root, cwd: s.cwd });
    try {
      expect(opened.id).toBe(forked.id);
    } finally {
      opened.close();
    }
  });

  it("选择器列表缺省不列子会话；includeSubagents 时列出并标记", () => {
    const s = seed();
    expect(listSessions({ sessionDir: s.root, cwd: s.cwd }).map((i) => i.id)).toEqual([s.parentId]);
    const all = listSessions({ sessionDir: s.root, cwd: s.cwd, includeSubagents: true });
    expect(all.map((i) => [i.id, i.subagent === true])).toEqual(
      expect.arrayContaining([
        [s.parentId, false],
        [s.childId, true],
      ]),
    );
  });

  it("显式 --resume <子会话 id> 仍可打开", () => {
    const s = seed();
    const opened = openSession(
      { kind: "resume", id: s.childId.slice(0, 8) },
      { sessionDir: s.root, cwd: s.cwd },
    );
    try {
      expect(opened.id).toBe(s.childId);
    } finally {
      opened.close();
    }
  });

  it("sessions list 缺省隐藏子会话，--all 列出并标 ↳ 子 Agent；prune 照常清理子会话", async () => {
    const s = seed();
    const out: string[] = [];
    const io: CliIo = {
      ...defaultIo(),
      stdout: (t) => void out.push(t),
      stderr: () => undefined,
      env: { ...(home?.env ?? {}) },
      cwd: s.cwd,
    };
    const deps = { sessions: createSessionStore() };
    expect(await runSessions(["list", "--session-dir", s.root], io, deps)).toBe(0);
    expect(out.join("")).toContain(s.parentId.slice(0, 8));
    expect(out.join("")).not.toContain(s.childId.slice(0, 8));
    out.length = 0;
    expect(await runSessions(["list", "--all", "--session-dir", s.root], io, deps)).toBe(0);
    const childRow = out.find((line) => line.startsWith(s.childId.slice(0, 8)));
    expect(childRow).toContain("↳ 子 Agent explore the repo");
    expect(out.find((line) => line.startsWith(s.parentId.slice(0, 8)))).not.toContain("↳");
    const pruned = await deps.sessions.prune?.({
      sessionDir: s.root,
      cwd: s.cwd,
      olderThanDays: -1,
      dryRun: true,
    });
    expect(pruned?.moved).toHaveLength(2);
  });
});
