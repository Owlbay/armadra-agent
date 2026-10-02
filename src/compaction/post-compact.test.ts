import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage } from "../ai/types.js";
import { SessionManager } from "../session/manager.js";
import { buildProjection } from "../session/projection.js";
import {
  MAX_RECENT_FILES,
  buildPostCompactBlock,
  buildPostCompactContent,
  stripPostCompact,
} from "./post-compact.js";
import { prepareCompaction } from "./summarize-tier.js";

const cwd = resolve("/w");
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  stopReason: "toolUse",
  timestamp: 0,
});
const result = (id: string, text: string, toolName = "read"): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  content: text,
  isError: false,
  timestamp: 0,
});

function session(): SessionManager {
  const m = SessionManager.inMemory(cwd);
  const tool = (id: string, name: string, args: Record<string, unknown>, out = "SECRET-BODY") => {
    m.append({ type: "message", message: call(id, name, args) });
    m.append({ type: "message", message: result(id, out, name) });
  };
  m.append({ type: "message", message: user("实现功能") });
  tool("r1", "read", { path: "src/a.ts" });
  tool("s1", "read", { path: "/skills/review/SKILL.md" });
  tool("e1", "edit", { path: "src/a.ts" });
  tool("r2", "read", { path: "src/b.ts" });
  tool("w1", "write", { path: "src/c.ts" });
  m.append({
    type: "custom",
    customType: "ama.todo",
    data: {
      items: [
        { id: "1", text: "读代码", status: "done" },
        { id: "2", text: "改实现", status: "in_progress" },
        { id: "3", text: "补测试", status: "pending" },
      ],
    },
  });
  m.append({
    type: "custom",
    customType: "ama.plan",
    data: {
      id: "p1",
      version: 2,
      status: "approved",
      markdown: "# 计划全文不回注",
      steps: [
        { id: "S1", text: "第一步" },
        { id: "S2", text: "第二步" },
      ],
      sourceEntryId: "x",
      filePath: "/plans/p1.md",
    },
  });
  return m;
}

describe("压缩后回注（C6，D26）", () => {
  it("todo、计划、已加载 Skill、最近文件、转录与 outputs 路径；不含文件正文与计划全文", () => {
    const text = buildPostCompactContent({
      branch: session().branch(),
      cwd,
      skillPaths: ["/skills/review/SKILL.md"],
      transcriptPath: "/sessions/s.jsonl",
      outputDir: "/sessions/outputs",
    });
    expect(text).toContain("<todo>\n[x] 1. 读代码\n[~] 2. 改实现\n[ ] 3. 补测试\n</todo>");
    expect(text).toContain('<plan id="p1" version="2" status="approved" file="/plans/p1.md">');
    expect(text).toContain("S1 第一步\nS2 第二步\n</plan>");
    expect(text).toContain(
      `<loaded-skills>\n${resolve("/skills/review/SKILL.md")}\n</loaded-skills>`,
    );
    // 最近的在前；改过的不再算读过
    expect(text).toContain(
      "<recently-modified-files>\nsrc/c.ts\nsrc/a.ts\n</recently-modified-files>",
    );
    expect(text).toContain("<recently-read-files>\nsrc/b.ts\n</recently-read-files>");
    expect(text).toContain("<transcript>/sessions/s.jsonl</transcript>");
    expect(text).toContain("<outputs>/sessions/outputs</outputs>");
    expect(text).toMatch(/Continue from the summary's Next Steps/);
    expect(text).not.toContain("SECRET-BODY");
    expect(text).not.toContain("计划全文不回注");
  });

  it("被拒绝 / 取代的计划不回注；没有状态时只给续接说明", () => {
    const m = SessionManager.inMemory(cwd);
    m.append({ type: "message", message: user("hi") });
    m.append({
      type: "custom",
      customType: "ama.plan",
      data: { id: "p", status: "rejected", steps: [] },
    });
    const text = buildPostCompactContent({ branch: m.branch(), cwd });
    expect(text).not.toContain("<plan");
    expect(text).not.toContain("<todo>");
    expect(text).toMatch(/Continue from/);
  });

  it("文件清单各至多 20 个，多出的给计数", () => {
    const m = SessionManager.inMemory(cwd);
    for (let i = 0; i < 25; i++)
      m.append({ type: "message", message: call(`r${i}`, "read", { path: `f${i}.ts` }) });
    const text = buildPostCompactContent({ branch: m.branch(), cwd });
    const block = /<recently-read-files>\n([\s\S]*?)\n<\/recently-read-files>/.exec(text)?.[1];
    expect(block?.split("\n")).toHaveLength(MAX_RECENT_FILES + 1);
    expect(block).toMatch(/^f24\.ts\n/);
    expect(block).toMatch(/\(\+5 more\)$/);
  });

  it("回注块可剥离；下一次增量摘要的 previousSummary 不含回注块", () => {
    const block = buildPostCompactBlock({ branch: session().branch(), cwd });
    expect(block).toMatch(/^<post-compact-state>\n[\s\S]*\n<\/post-compact-state>$/);
    const summary = `## Goal\nx\n\n<read-files>\na.ts\n</read-files>\n\n${block}`;
    expect(stripPostCompact(summary)).toBe("## Goal\nx\n\n<read-files>\na.ts\n</read-files>");

    const m = SessionManager.inMemory(cwd);
    const first = m.append({ type: "message", message: user("a ".repeat(400)) });
    m.append({
      type: "compaction",
      summary,
      firstKeptEntryId: first.id,
      tokensBefore: 1,
    });
    m.append({ type: "message", message: user("b ".repeat(400)) });
    m.append({ type: "message", message: user("c ".repeat(400)) });
    const plan = prepareCompaction(buildProjection(m.branch()), 50);
    expect(plan?.previousSummary).toBe(stripPostCompact(summary));
  });
});
