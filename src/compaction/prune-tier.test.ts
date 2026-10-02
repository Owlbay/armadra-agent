import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import type { AssistantMessage, Message, ToolResultMessage } from "../ai/types.js";
import { SessionManager } from "../session/manager.js";
import { buildProjection } from "../session/projection.js";
import { createProtection, readPathOf, skillLocations } from "./protect.js";
import { planPrune, prunePolicy, type PrunePolicy } from "./prune-tier.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

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

/** 一条 user 消息 + n 次工具调用，每个结果 `size` 个 ASCII 字符（≈ size/4 token）。 */
function longTask(n: number, size: number): SessionManager {
  const m = SessionManager.inMemory("/w");
  m.append({ type: "message", message: user("只有这一条用户消息") });
  for (let i = 0; i < n; i++) {
    m.append({ type: "message", message: call(`c${i}`, "read", { path: `f${i}.ts` }) });
    m.append({ type: "message", message: result(`c${i}`, String(i % 10).repeat(size)) });
  }
  return m;
}

const policy = (over: Partial<PrunePolicy> = {}): PrunePolicy => ({
  ...prunePolicy(100_000),
  ...over,
});

describe("prunePolicy（D27 缺省）", () => {
  it("随预算缩放：protect = min(40k, 0.2×)，clearAtLeast auto = max(20k, 0.1×) 且 ≤ 0.2×，0.7 / 0.5", () => {
    expect(prunePolicy(100_000)).toMatchObject({
      keepResults: 5,
      protectTokens: 20_000,
      clearAtLeast: 20_000,
      minTokens: 512,
      triggerTokens: 70_000,
      targetTokens: 50_000,
    });
    expect(prunePolicy(1_000_000)).toMatchObject({ protectTokens: 40_000, clearAtLeast: 100_000 });
    // 小窗口：20k 超过触发线与目标之差（0.2×），按 0.2× 封顶
    expect(prunePolicy(50_000)).toMatchObject({ protectTokens: 10_000, clearAtLeast: 10_000 });
    expect(prunePolicy(100_000, { keepResults: 2, clearAtLeast: 5000 })).toMatchObject({
      keepResults: 2,
      clearAtLeast: 5000,
    });
    expect(prunePolicy(100_000, { clearAtLeast: "auto" }).clearAtLeast).toBe(20_000);
  });
});

describe("档一 planPrune（C1 / C2）", () => {
  it("单 user 消息 + 50 次工具调用也能裁（G1）：最近 keepResults 个与 protectTokens 内不动", () => {
    const m = longTask(50, 8000); // 每个 2 000 token
    const plan = planPrune(buildProjection(m.branch()).items, {
      policy: policy({ keepResults: 5, protectTokens: 20_000, clearAtLeast: 1000 }),
    });
    // 最近 10 个（20k token 内）受保护，其余 40 个都是候选；need 缺省 = 全部
    expect(plan.items).toHaveLength(40);
    expect(plan.items[0]?.toolCallId).toBe("c0");
    expect(plan.items.at(-1)?.toolCallId).toBe("c39");
    expect(plan.savedTokens).toBe(plan.availableTokens);
    expect(plan.items[0]?.replacement).toMatch(
      /^\[pruned: read result was 8000 bytes; full text unavailable\]$/,
    );
  });

  it("keepResults 比 protectTokens 更宽时以 keepResults 为准", () => {
    const m = longTask(10, 8000);
    const plan = planPrune(buildProjection(m.branch()).items, {
      policy: policy({ keepResults: 8, protectTokens: 0, clearAtLeast: 0 }),
    });
    expect(plan.items.map((p) => p.toolCallId)).toEqual(["c0", "c1"]);
  });

  it("可省 < clearAtLeast 不动", () => {
    const m = longTask(10, 8000);
    const items = buildProjection(m.branch()).items;
    const opts = { keepResults: 5, protectTokens: 0 };
    const none = planPrune(items, { policy: policy({ ...opts, clearAtLeast: 20_000 }) });
    expect(none.items).toEqual([]);
    expect(none.availableTokens).toBeLessThan(20_000);
    const some = planPrune(items, { policy: policy({ ...opts, clearAtLeast: 5000 }) });
    expect(some.items).toHaveLength(5);
  });

  it("一次清到目标：从最旧开始，省够 need（至少 clearAtLeast）即停", () => {
    const m = longTask(50, 8000);
    const items = buildProjection(m.branch()).items;
    const base = { keepResults: 5, protectTokens: 0 };
    const plan = planPrune(items, { policy: policy({ ...base, clearAtLeast: 1000 }), need: 5000 });
    expect(plan.items.map((p) => p.toolCallId)).toEqual(["c0", "c1", "c2"]);
    expect(plan.savedTokens).toBeGreaterThanOrEqual(5000);
    // need 小于 clearAtLeast 时按 clearAtLeast
    const atLeast = planPrune(items, {
      policy: policy({ ...base, clearAtLeast: 9000 }),
      need: 100,
    });
    expect(atLeast.savedTokens).toBeGreaterThanOrEqual(9000);
    expect(atLeast.items).toHaveLength(5);
  });

  it("≤ 512 token 的结果与已裁过的结果不再是候选；选中项全文落盘", () => {
    home = createTmpHome("ama-w5h1-prune-");
    const m = SessionManager.inMemory("/w");
    m.append({ type: "message", message: user("task") });
    m.append({ type: "message", message: call("big", "read", { path: "a" }) });
    const big = m.append({ type: "message", message: result("big", "A".repeat(5000)) });
    m.append({ type: "message", message: call("small", "read", { path: "b" }) });
    m.append({ type: "message", message: result("small", "中".repeat(500)) });
    m.append({ type: "message", message: call("recent", "read", { path: "c" }) });
    m.append({ type: "message", message: result("recent", "C".repeat(5000)) });
    const opts = {
      policy: policy({ keepResults: 1, protectTokens: 0, clearAtLeast: 0 }),
      outputDir: home.path("outputs"),
    };
    const plan = planPrune(buildProjection(m.branch()).items, opts);
    expect(plan.items.map((p) => p.targetId)).toEqual([big.id]);
    expect(plan.items[0]?.replacement).toMatch(/^\[pruned: .*full text at .*big\.txt\]$/);
    expect(readFileSync(plan.items[0]?.fullTextPath as string, "utf8")).toHaveLength(5000);
    for (const item of plan.items)
      m.append({
        type: "context_edit",
        targetId: item.targetId,
        replacement: item.replacement,
        reason: "prune",
      });
    expect(planPrune(buildProjection(m.branch()).items, opts).items).toEqual([]);
  });

  it("中文结果按字计 token：2 000 个汉字超过 512，裁", () => {
    const m = SessionManager.inMemory("/w");
    m.append({ type: "message", message: user("task") });
    m.append({ type: "message", message: call("zh", "read", { path: "a" }) });
    m.append({ type: "message", message: result("zh", "中".repeat(2000)) });
    m.append({ type: "message", message: call("x", "read", { path: "b" }) });
    m.append({ type: "message", message: result("x", "ok") });
    const plan = planPrune(buildProjection(m.branch()).items, {
      policy: policy({ keepResults: 1, protectTokens: 0, clearAtLeast: 0 }),
    });
    expect(plan.items.map((p) => p.toolCallId)).toEqual(["zh"]);
    expect(plan.savedTokens).toBeGreaterThan(1900);
  });
});

describe("保护集（C4）", () => {
  const cwd = resolve("/w");
  const skill = resolve("/skills/review/SKILL.md");
  const build = (): SessionManager => {
    const m = SessionManager.inMemory(cwd);
    m.append({
      type: "message",
      message: {
        role: "system",
        sections: {
          preamble: "p",
          skills: `<available_skills>\n  <skill>\n    <name>review</name>\n    <location>${skill}</location>\n  </skill>\n</available_skills>`,
        },
        timestamp: 0,
      },
    });
    m.append({ type: "message", message: user("task") });
    const add = (id: string, name: string, args: Record<string, unknown>): void => {
      m.append({ type: "message", message: call(id, name, args) });
      m.append({ type: "message", message: result(id, "z".repeat(8000), name) });
    };
    add("skill-read", "read", { path: skill });
    add("agents", "read", { path: "AGENTS.md" });
    add("todo", "todo", { action: "set" });
    add("host", "host_notes", {});
    add("excluded", "grep", { pattern: "x" });
    add("plain", "read", { path: "src/a.ts" });
    add("recent", "read", { path: "src/b.ts" });
    return m;
  };

  it("Skill 文件、AGENTS.md、todo、keepInContext 工具与 pruneExclude 都不裁", () => {
    const items = buildProjection(build().branch()).items;
    expect(skillLocations(items)).toEqual([skill]);
    const isProtected = createProtection({
      cwd,
      skillPaths: skillLocations(items),
      exclude: ["grep"],
      keepInContext: (name) => name === "host_notes",
    });
    const plan = planPrune(items, {
      policy: policy({ keepResults: 1, protectTokens: 0, clearAtLeast: 0 }),
      isProtected,
    });
    expect(plan.items.map((p) => p.toolCallId)).toEqual(["plain"]);
  });

  it("不给保护集时都是候选（对照）", () => {
    const plan = planPrune(buildProjection(build().branch()).items, {
      policy: policy({ keepResults: 1, protectTokens: 0, clearAtLeast: 0 }),
    });
    expect(plan.items).toHaveLength(6);
  });

  it("readPathOf 只认 read 的 path，相对路径按 cwd 解析", () => {
    expect(readPathOf({ toolName: "read", args: { path: "a/b.ts" } }, cwd)).toBe(
      resolve(cwd, "a/b.ts"),
    );
    expect(readPathOf({ toolName: "write", args: { path: "a" } }, cwd)).toBeUndefined();
    expect(readPathOf({ toolName: "read", args: undefined }, cwd)).toBeUndefined();
  });
});
